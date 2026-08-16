//! Pseudo-terminal plumbing.
//!
//! This module knows how to run a process on a pty and move bytes in and out of
//! it. It deliberately knows nothing about the database or about Tauri, which is
//! what lets the whole layer be exercised headlessly in the tests at the bottom
//! of this file.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::error::{Error, Result};

/// Output retained per session so a pane that remounts, or a webview that
/// reloads, can be caught up before live output resumes.
const SCROLLBACK_LIMIT: usize = 256 * 1024;

const READ_BUFFER: usize = 8 * 1024;

/// Where a session's output goes. A trait rather than a concrete Tauri channel
/// so that tests can collect output without a webview.
pub trait OutputSink: Send + Sync {
    fn emit(&self, bytes: &[u8]);
}

/// Called from the waiter thread once a child has exited.
pub type ExitHandler = Box<dyn FnOnce(Option<i32>) + Send>;

pub struct SpawnOptions {
    pub id: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
}

/// None of the locks in here guard an invariant that a panic could break, so a
/// poisoned lock is recovered from rather than propagated. Losing a terminal
/// because an unrelated thread panicked would be worse than the alternative.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Default)]
struct Stream {
    scrollback: Mutex<VecDeque<u8>>,
    sink: Mutex<Option<Arc<dyn OutputSink>>>,
}

impl Stream {
    fn publish(&self, bytes: &[u8]) {
        // Lock order is scrollback then sink, matching `attach`, so the two
        // cannot deadlock against each other.
        let mut scrollback = lock(&self.scrollback);
        scrollback.extend(bytes);
        let overflow = scrollback.len().saturating_sub(SCROLLBACK_LIMIT);
        if overflow > 0 {
            scrollback.drain(..overflow);
        }
        drop(scrollback);

        let sink = lock(&self.sink).clone();
        if let Some(sink) = sink {
            sink.emit(bytes);
        }
    }

    fn attach(&self, sink: Arc<dyn OutputSink>) {
        let scrollback = lock(&self.scrollback);
        let mut current = lock(&self.sink);
        if !scrollback.is_empty() {
            sink.emit(&scrollback.iter().copied().collect::<Vec<u8>>());
        }
        *current = Some(sink);
    }
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    stream: Arc<Stream>,
    process_id: Option<u32>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts `program` on a new pty. `on_exit` runs on the waiter thread once
    /// the child terminates.
    pub fn spawn(&self, options: SpawnOptions, on_exit: ExitHandler) -> Result<Option<u32>> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: options.rows.max(1),
                cols: options.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| Error::Pty(format!("could not open a pty: {error}")))?;

        let mut command = CommandBuilder::new(&options.program);
        for arg in &options.args {
            command.arg(arg);
        }
        command.cwd(&options.cwd);
        // Without these the child assumes a dumb terminal and renders neither
        // colour nor cursor addressing.
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        let mut child = pair.slave.spawn_command(command).map_err(|error| {
            Error::Pty(format!(
                "could not start `{}`: {error}",
                options.program.clone()
            ))
        })?;

        // The slave handle exists only to spawn the child. Holding on to it
        // keeps the pty open, so the reader would never observe EOF.
        drop(pair.slave);

        let process_id = child.process_id();
        let killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| Error::Pty(format!("could not read from the pty: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| Error::Pty(format!("could not write to the pty: {error}")))?;

        let stream = Arc::new(Stream::default());

        let reader_stream = Arc::clone(&stream);
        std::thread::Builder::new()
            .name(format!("pty-read-{}", options.id))
            .spawn(move || {
                let mut reader = reader;
                let mut buffer = [0u8; READ_BUFFER];
                loop {
                    // EOF arrives as `Ok(0)`, not as an error.
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => reader_stream.publish(&buffer[..count]),
                    }
                }
            })
            .map_err(|error| Error::Pty(format!("could not start the pty reader: {error}")))?;

        std::thread::Builder::new()
            .name(format!("pty-wait-{}", options.id))
            .spawn(move || {
                let code = child.wait().ok().map(|status| status.exit_code() as i32);
                on_exit(code);
            })
            .map_err(|error| Error::Pty(format!("could not start the pty waiter: {error}")))?;

        lock(&self.sessions).insert(
            options.id,
            PtySession {
                master: pair.master,
                writer: Mutex::new(writer),
                killer: Mutex::new(killer),
                stream,
                process_id,
            },
        );

        Ok(process_id)
    }

    /// Points a session's output at `sink`, replaying whatever scrollback is
    /// still buffered so the pane is not left with a blank screen.
    pub fn attach(&self, id: &str, sink: Arc<dyn OutputSink>) -> Result<()> {
        let sessions = lock(&self.sessions);
        let session = sessions
            .get(id)
            .ok_or_else(|| Error::SessionNotFound(id.to_string()))?;
        session.stream.attach(sink);
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let sessions = lock(&self.sessions);
        let session = sessions.get(id).ok_or(Error::SessionNotRunning)?;
        let mut writer = lock(&session.writer);
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|error| Error::Pty(format!("could not write to the session: {error}")))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let sessions = lock(&self.sessions);
        let session = sessions.get(id).ok_or(Error::SessionNotRunning)?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| Error::Pty(format!("could not resize the session: {error}")))
    }

    /// Signals the child to terminate. The waiter thread reports the exit.
    pub fn kill(&self, id: &str) -> Result<()> {
        let sessions = lock(&self.sessions);
        let session = sessions.get(id).ok_or(Error::SessionNotRunning)?;
        let killed = lock(&session.killer).kill();
        killed.map_err(|error| Error::Pty(format!("could not stop the session: {error}")))
    }

    /// Drops the pty handles for a session. This is what releases the last
    /// reference to the pty, letting the reader thread see EOF and finish.
    pub fn remove(&self, id: &str) {
        lock(&self.sessions).remove(id);
    }

    /// Terminates every live session. Called when the app quits so agents do
    /// not outlive the window that was supervising them.
    pub fn shutdown(&self) {
        let mut sessions = lock(&self.sessions);
        for session in sessions.values() {
            let _ = lock(&session.killer).kill();
        }
        sessions.clear();
    }

    pub fn is_running(&self, id: &str) -> bool {
        lock(&self.sessions).contains_key(id)
    }

    pub fn process_id(&self, id: &str) -> Option<u32> {
        lock(&self.sessions).get(id).and_then(|s| s.process_id)
    }

    /// The size the kernel currently reports for the session's pty.
    pub fn size(&self, id: &str) -> Result<(u16, u16)> {
        let sessions = lock(&self.sessions);
        let session = sessions.get(id).ok_or(Error::SessionNotRunning)?;
        let size = session
            .master
            .get_size()
            .map_err(|error| Error::Pty(format!("could not read the session size: {error}")))?;
        Ok((size.cols, size.rows))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

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

    /// Polls rather than sleeping a fixed amount, so the tests stay fast when
    /// things go well and still tolerate a loaded machine.
    fn wait_for(label: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out waiting for {label}");
    }

    struct Fixture {
        manager: PtyManager,
        collector: Arc<Collector>,
        exits: mpsc::Receiver<Option<i32>>,
        id: String,
    }

    impl Fixture {
        fn spawn(script: &str) -> Self {
            let manager = PtyManager::new();
            let collector = Arc::new(Collector::default());
            let (tx, exits) = mpsc::channel();
            let id = "test-session".to_string();

            manager
                .spawn(
                    SpawnOptions {
                        id: id.clone(),
                        program: "/bin/sh".into(),
                        args: vec!["-c".into(), script.into()],
                        cwd: std::env::temp_dir(),
                        cols: 80,
                        rows: 24,
                    },
                    Box::new(move |code| {
                        let _ = tx.send(code);
                    }),
                )
                .expect("the session should spawn");

            manager
                .attach(&id, collector.clone())
                .expect("the sink should attach");

            Self {
                manager,
                collector,
                exits,
                id,
            }
        }

        fn wait_for_output(&self, needle: &str) {
            wait_for(&format!("output containing {needle:?}"), || {
                self.collector.text().contains(needle)
            });
        }

        fn wait_for_exit(&self) -> Option<i32> {
            self.exits
                .recv_timeout(Duration::from_secs(10))
                .expect("the child should report an exit")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.manager.remove(&self.id);
        }
    }

    #[test]
    fn streams_child_output_to_the_sink() {
        let fixture = Fixture::spawn("printf 'hello-from-pty'");

        fixture.wait_for_output("hello-from-pty");
        assert_eq!(fixture.wait_for_exit(), Some(0));
    }

    #[test]
    fn reports_a_nonzero_exit_code() {
        let fixture = Fixture::spawn("exit 3");

        assert_eq!(fixture.wait_for_exit(), Some(3));
    }

    #[test]
    fn input_written_to_the_session_reaches_the_child() {
        let fixture = Fixture::spawn("read line; printf 'echoed:%s' \"$line\"");

        fixture
            .manager
            .write(&fixture.id, b"marco\n")
            .expect("the write should succeed");

        fixture.wait_for_output("echoed:marco");
    }

    #[test]
    fn a_program_can_see_the_terminal_size_and_the_resized_size() {
        // `stty size` reports what the kernel thinks the pty measures, which is
        // the same thing a TUI reads when it lays itself out.
        let fixture = Fixture::spawn("sleep 30");

        assert_eq!(fixture.manager.size(&fixture.id).unwrap(), (80, 24));

        fixture
            .manager
            .resize(&fixture.id, 120, 40)
            .expect("the resize should succeed");

        assert_eq!(fixture.manager.size(&fixture.id).unwrap(), (120, 40));
    }

    #[test]
    fn killing_a_running_session_makes_it_exit() {
        let fixture = Fixture::spawn("sleep 30");

        fixture
            .manager
            .kill(&fixture.id)
            .expect("the kill should succeed");

        // A signalled child still reports through the waiter thread.
        fixture.wait_for_exit();
    }

    #[test]
    fn attaching_late_replays_the_scrollback() {
        let manager = PtyManager::new();
        let (tx, exits) = mpsc::channel();
        let id = "replay".to_string();

        manager
            .spawn(
                SpawnOptions {
                    id: id.clone(),
                    program: "/bin/sh".into(),
                    args: vec!["-c".into(), "printf 'printed-before-attach'".into()],
                    cwd: std::env::temp_dir(),
                    cols: 80,
                    rows: 24,
                },
                Box::new(move |code| {
                    let _ = tx.send(code);
                }),
            )
            .expect("the session should spawn");

        exits
            .recv_timeout(Duration::from_secs(10))
            .expect("the child should exit");

        let collector = Arc::new(Collector::default());
        wait_for("scrollback to replay on attach", || {
            manager.attach(&id, collector.clone()).is_ok()
                && collector.text().contains("printed-before-attach")
        });

        manager.remove(&id);
    }

    #[test]
    fn removing_a_session_forgets_it() {
        let manager = PtyManager::new();
        let (tx, _exits) = mpsc::channel();

        manager
            .spawn(
                SpawnOptions {
                    id: "gone".into(),
                    program: "/bin/sh".into(),
                    args: vec!["-c".into(), "sleep 30".into()],
                    cwd: std::env::temp_dir(),
                    cols: 80,
                    rows: 24,
                },
                Box::new(move |code| {
                    let _ = tx.send(code);
                }),
            )
            .expect("the session should spawn");

        assert!(manager.is_running("gone"));
        manager.kill("gone").expect("the kill should succeed");
        manager.remove("gone");

        assert!(!manager.is_running("gone"));
        assert!(matches!(
            manager.write("gone", b"x"),
            Err(Error::SessionNotRunning)
        ));
    }

    #[test]
    fn spawning_a_missing_program_fails_with_its_name() {
        let manager = PtyManager::new();
        let (tx, _exits) = mpsc::channel();

        let error = manager
            .spawn(
                SpawnOptions {
                    id: "missing".into(),
                    program: "grokspace-no-such-binary".into(),
                    args: vec![],
                    cwd: std::env::temp_dir(),
                    cols: 80,
                    rows: 24,
                },
                Box::new(move |code| {
                    let _ = tx.send(code);
                }),
            )
            .expect_err("spawning a missing program should fail");

        assert!(
            error.to_string().contains("grokspace-no-such-binary"),
            "the error should name the program, got: {error}"
        );
    }
}
