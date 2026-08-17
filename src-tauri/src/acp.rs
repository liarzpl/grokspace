//! Driving a Grok agent over ACP instead of over a terminal.
//!
//! `grok agent stdio` speaks JSON-RPC on stdin and stdout rather than rendering a
//! TUI, which is the whole reason this module exists: a pty carries pixels, and
//! pixels cannot say whether an agent is working, finished, or waiting to be
//! answered. The four session statuses the schema has carried since Phase 0 come
//! from this flow.
//!
//! Like [`crate::pty`], this knows nothing about Tauri or the database, so the
//! interesting half is exercised in the tests at the bottom with no child process
//! at all — and, more to the point, with no `grok` binary.
//!
//! Only the messages GrokSpace actually needs are modelled. The full ACP schema is
//! large and mostly about content GrokSpace does not render, and a partial model
//! that says so is more honest than one that looks complete.

use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{json, Value};

use crate::error::{Error, Result};

/// The ACP revision `grok` speaks. Its own documented client example sends this,
/// and it matters: `state_update`, which would have answered the status question
/// directly, only exists from v2 onwards.
const PROTOCOL_VERSION: &str = "1";

/// How long the opening handshake may take before the agent is called unusable.
/// Generous, because a first run can be doing a token refresh, but finite: a
/// silent agent must not hang the command that started it.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Recovered from rather than propagated, for the reason `pty.rs` gives: nothing in
/// here guards an invariant a panic could break, and losing an agent because an
/// unrelated thread panicked would be the worse outcome.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the agent is doing, as far as the message flow can say.
///
/// Deliberately not `crate::session::SessionStatus`: that enum also carries
/// `Stopped`, which is about the process rather than the conversation and is
/// decided by the waiter thread, not by anything here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus {
    Idle,
    Running,
    NeedsInput,
}

/// A permission the agent is waiting on, surfaced so it can be put to the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRequest {
    /// The JSON-RPC id to answer with; the agent stays blocked until it is.
    pub id: u64,
    /// What the agent wants to do, in whatever words it used.
    pub summary: String,
}

/// What one incoming line means to GrokSpace. Everything the status does not
/// depend on collapses into `Ignored`, which is most of the protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    /// A reply to something we sent.
    Response {
        id: u64,
    },
    /// The agent asking to be allowed to do something.
    Permission(PermissionRequest),
    Ignored,
}

/// Reads one line of JSON-RPC and says what it is.
///
/// A line that is not JSON at all is ignored rather than fatal. The agent shares
/// stdout with anything its own dependencies decide to print, and one stray line
/// must not take the session down.
pub fn classify(line: &str) -> Incoming {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Incoming::Ignored;
    };

    let id = message.get("id").and_then(Value::as_u64);
    let method = message.get("method").and_then(Value::as_str);

    match (method, id) {
        // A request from the agent: it has both a method and an id, and it is
        // waiting for an answer.
        (Some("session/request_permission"), Some(id)) => Incoming::Permission(PermissionRequest {
            id,
            summary: permission_summary(&message),
        }),
        // A reply to us: an id and no method.
        (None, Some(id)) => Incoming::Response { id },
        _ => Incoming::Ignored,
    }
}

/// The best sentence available for a permission prompt.
///
/// ACP puts the tool call under `params.toolCall`, whose shape varies by tool, so
/// this reaches for the fields most likely to be there and falls back rather than
/// insisting. A vague prompt is better than none.
fn permission_summary(message: &Value) -> String {
    let params = message.get("params");
    let tool = params.and_then(|params| params.get("toolCall"));

    for key in ["title", "rawInput", "kind"] {
        if let Some(text) = tool.and_then(|tool| tool.get(key)).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
    }
    "The agent is asking for permission to continue.".to_string()
}

/// What the flow says the session is doing.
///
/// ACP v1 has no status message, so this is derived rather than read: a prompt we
/// sent and have had no reply to means work is happening, and a permission request
/// we have not answered outranks it, because nothing moves until it is answered.
#[derive(Debug, Default)]
pub struct StatusTracker {
    prompt: Option<u64>,
    permissions: BTreeSet<u64>,
}

impl StatusTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> AgentStatus {
        if !self.permissions.is_empty() {
            AgentStatus::NeedsInput
        } else if self.prompt.is_some() {
            AgentStatus::Running
        } else {
            AgentStatus::Idle
        }
    }

    /// Records that a prompt has gone out and is awaiting its reply.
    pub fn prompt_sent(&mut self, id: u64) {
        self.prompt = Some(id);
    }

    /// Records an answer to a permission request, which unblocks the agent.
    pub fn permission_answered(&mut self, id: u64) {
        self.permissions.remove(&id);
    }

    /// Folds one incoming message in. Returns the status if it changed, so a
    /// caller can report transitions rather than every line.
    pub fn observe(&mut self, incoming: &Incoming) -> Option<AgentStatus> {
        let before = self.status();
        match incoming {
            Incoming::Permission(request) => {
                self.permissions.insert(request.id);
            }
            Incoming::Response { id } => {
                // Only the reply to the prompt ends the turn. Replies to the
                // handshake arrive first and mean nothing about the conversation.
                if self.prompt == Some(*id) {
                    self.prompt = None;
                }
            }
            Incoming::Ignored => {}
        }
        let after = self.status();
        (after != before).then_some(after)
    }
}

/// What a live agent reports, on the reader thread.
pub struct Callbacks {
    pub on_status: Box<dyn Fn(AgentStatus) + Send + Sync>,
    pub on_permission: Box<dyn Fn(PermissionRequest) + Send + Sync>,
    /// The agent's stdout ended, which for a child process means it is gone.
    pub on_closed: Box<dyn FnOnce() + Send>,
}

pub struct StartOptions {
    pub id: String,
    pub program: String,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

/// The writing half of a live agent, plus what is needed to end it.
struct Agent {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    tracker: Arc<Mutex<StatusTracker>>,
    next_id: AtomicU64,
    /// The id ACP gave the conversation, which every session-scoped call needs.
    acp_session: String,
    process_id: Option<u32>,
}

#[derive(Default)]
pub struct AcpManager {
    agents: Mutex<HashMap<String, Arc<Agent>>>,
}

impl AcpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts an agent, completes the ACP handshake, and leaves a thread reading
    /// its output.
    ///
    /// `--always-approve` is deliberately not passed. The Grok docs recommend it
    /// for automation, and it would remove permission requests altogether — which
    /// is the only thing `needs_input` can mean.
    pub fn start(&self, options: StartOptions, callbacks: Callbacks) -> Result<Option<u32>> {
        let mut child = Command::new(&options.program)
            .args(["agent", "stdio"])
            .current_dir(&options.cwd)
            .envs(options.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Left to the parent's stderr: an agent that cannot start explains
            // itself there, and swallowing it would make that invisible.
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                Error::Pty(format!("could not start `{}`: {error}", options.program))
            })?;

        let process_id = Some(child.id());
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Pty("the agent has no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Pty("the agent has no stdout".into()))?;

        let mut reader = BufReader::new(stdout);
        let mut stdin = stdin;
        let acp_session = handshake(&mut stdin, &mut reader, &options.cwd)?;

        let agent = Arc::new(Agent {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            tracker: Arc::new(Mutex::new(StatusTracker::new())),
            next_id: AtomicU64::new(HANDSHAKE_IDS + 1),
            acp_session,
            process_id,
        });

        let tracker = Arc::clone(&agent.tracker);
        std::thread::Builder::new()
            .name(format!("acp-read-{}", options.id))
            .spawn(move || read_loop(reader, tracker, callbacks))
            .map_err(|error| Error::Pty(format!("could not start the agent reader: {error}")))?;

        lock(&self.agents).insert(options.id, agent);
        Ok(process_id)
    }

    fn agent(&self, id: &str) -> Result<Arc<Agent>> {
        lock(&self.agents)
            .get(id)
            .cloned()
            .ok_or(Error::SessionNotRunning)
    }

    /// Sends a prompt and marks the session as working.
    pub fn prompt(&self, id: &str, text: &str) -> Result<()> {
        let agent = self.agent(id)?;
        let request_id = agent.next_id.fetch_add(1, Ordering::Relaxed);
        lock(&agent.tracker).prompt_sent(request_id);

        // Bound to a local rather than left a temporary: locals drop in reverse
        // order, so this guard has to be declared after `agent` to be released
        // before it.
        let mut stdin = lock(&agent.stdin);
        write_message(
            &mut *stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/prompt",
                "params": {
                    "sessionId": agent.acp_session,
                    "prompt": [{ "type": "text", "text": text }],
                },
            }),
        )
    }

    /// Answers a permission request, which is what lets the agent carry on.
    pub fn answer_permission(&self, id: &str, request_id: u64, allow: bool) -> Result<()> {
        let agent = self.agent(id)?;
        let outcome = if allow {
            json!({ "outcome": "selected", "optionId": "allow" })
        } else {
            json!({ "outcome": "cancelled" })
        };

        let mut stdin = lock(&agent.stdin);
        let sent = write_message(
            &mut *stdin,
            &json!({ "jsonrpc": "2.0", "id": request_id, "result": outcome }),
        );
        // Recorded only once the answer is out, so a failed write cannot leave the
        // session reading as answered while the agent is still waiting.
        if sent.is_ok() {
            lock(&agent.tracker).permission_answered(request_id);
        }
        sent
    }

    pub fn status(&self, id: &str) -> Result<AgentStatus> {
        Ok(lock(&self.agent(id)?.tracker).status())
    }

    pub fn process_id(&self, id: &str) -> Option<u32> {
        self.agent(id).ok().and_then(|agent| agent.process_id)
    }

    /// Asks the agent to stop what it is doing without ending the session.
    pub fn cancel(&self, id: &str) -> Result<()> {
        let agent = self.agent(id)?;
        let mut stdin = lock(&agent.stdin);
        write_message(
            &mut *stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": { "sessionId": agent.acp_session },
            }),
        )
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let agent = self.agent(id)?;
        let killed = lock(&agent.child).kill();
        killed.map_err(|error| Error::Pty(format!("could not stop the agent: {error}")))
    }

    /// Forgets the agent, which drops its stdin and lets the reader see the end.
    pub fn remove(&self, id: &str) {
        lock(&self.agents).remove(id);
    }

    pub fn is_running(&self, id: &str) -> bool {
        lock(&self.agents).contains_key(id)
    }

    /// Ends every agent, so none outlives the window it was reporting to.
    pub fn shutdown(&self) {
        let mut agents = lock(&self.agents);
        for agent in agents.values() {
            let _ = lock(&agent.child).kill();
        }
        agents.clear();
    }
}

/// The two ids the handshake uses, so a prompt can never collide with them.
const HANDSHAKE_IDS: u64 = 2;

fn write_message(stdin: &mut impl Write, message: &Value) -> Result<()> {
    // Newline-delimited, which is what the stdio transport expects: one JSON
    // object per line, flushed, because the agent is waiting on it.
    let line = serde_json::to_string(message)?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|()| stdin.write_all(b"\n"))
        .and_then(|()| stdin.flush())
        .map_err(|error| Error::Pty(format!("could not write to the agent: {error}")))
}

/// `initialize` then `session/new`, returning the id ACP gave the conversation.
///
/// Split out so it can be driven against a scripted agent in the tests rather
/// than only against the real binary.
fn handshake(
    stdin: &mut impl Write,
    reader: &mut impl BufRead,
    cwd: &std::path::Path,
) -> Result<String> {
    write_message(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                // Only what GrokSpace can actually honour. Claiming a capability it
                // does not implement would have the agent wait on a reply that
                // never comes.
                "clientCapabilities": {},
            },
        }),
    )?;

    write_message(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": { "cwd": cwd.to_string_lossy(), "mcpServers": [] },
        }),
    )?;

    let deadline = std::time::Instant::now() + HANDSHAKE_TIMEOUT;
    let mut line = String::new();
    loop {
        if std::time::Instant::now() > deadline {
            return Err(Error::Pty(
                "the agent did not answer the ACP handshake in time".into(),
            ));
        }

        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| Error::Pty(format!("could not read from the agent: {error}")))?;
        if read == 0 {
            return Err(Error::Pty(
                "the agent exited before the ACP handshake finished".into(),
            ));
        }

        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("id").and_then(Value::as_u64) != Some(2) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(Error::Pty(format!("the agent refused a session: {error}")));
        }
        if let Some(session) = message
            .get("result")
            .and_then(|result| result.get("sessionId"))
            .and_then(Value::as_str)
        {
            return Ok(session.to_string());
        }
        return Err(Error::Pty(
            "the agent opened a session without giving it an id".into(),
        ));
    }
}

/// Reports what the agent says until its output ends.
fn read_loop(mut reader: impl BufRead, tracker: Arc<Mutex<StatusTracker>>, callbacks: Callbacks) {
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }

        let incoming = classify(&line);
        if let Incoming::Permission(request) = &incoming {
            (callbacks.on_permission)(request.clone());
        }
        let changed = lock(&tracker).observe(&incoming);
        if let Some(status) = changed {
            (callbacks.on_status)(status);
        }
    }
    (callbacks.on_closed)();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_is_told_apart_from_a_request() {
        // Both carry an id; only a request also carries a method, and that is the
        // whole difference between "the agent answered" and "the agent is asking".
        assert_eq!(
            classify(r#"{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}"#),
            Incoming::Response { id: 7 }
        );
        assert!(matches!(
            classify(r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission"}"#),
            Incoming::Permission(_)
        ));
    }

    #[test]
    fn a_notification_and_a_stray_line_are_both_ignored() {
        // session/update carries the agent's output, which the status does not
        // depend on, and stdout is shared with whatever else decides to print.
        assert_eq!(
            classify(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#),
            Incoming::Ignored
        );
        assert_eq!(classify("warning: something unrelated"), Incoming::Ignored);
        assert_eq!(classify(""), Incoming::Ignored);
    }

    #[test]
    fn a_permission_request_is_summarised_from_whatever_it_offers() {
        let titled = classify(
            r#"{"id":1,"method":"session/request_permission",
                "params":{"toolCall":{"title":"Run `git push`"}}}"#,
        );
        assert_eq!(
            titled,
            Incoming::Permission(PermissionRequest {
                id: 1,
                summary: "Run `git push`".to_string()
            })
        );

        // The shape varies per tool, so an unhelpful one still has to produce a
        // sentence someone can be asked about.
        let bare = classify(r#"{"id":2,"method":"session/request_permission","params":{}}"#);
        let Incoming::Permission(request) = bare else {
            panic!("a permission request should be recognised without a tool call")
        };
        assert!(request.summary.contains("permission"));
    }

    #[test]
    fn a_session_with_nothing_outstanding_is_idle() {
        assert_eq!(StatusTracker::new().status(), AgentStatus::Idle);
    }

    #[test]
    fn a_prompt_runs_until_its_own_reply_arrives() {
        let mut tracker = StatusTracker::new();

        tracker.prompt_sent(5);
        assert_eq!(tracker.status(), AgentStatus::Running);

        // A reply to something else - the handshake, or a permission - must not
        // end the turn.
        assert_eq!(tracker.observe(&Incoming::Response { id: 2 }), None);
        assert_eq!(tracker.status(), AgentStatus::Running);

        assert_eq!(
            tracker.observe(&Incoming::Response { id: 5 }),
            Some(AgentStatus::Idle)
        );
    }

    #[test]
    fn an_unanswered_permission_outranks_the_work_it_interrupted() {
        // Nothing moves until it is answered, so reporting `running` would be a
        // terminal that looks busy while it waits on a person.
        let mut tracker = StatusTracker::new();
        tracker.prompt_sent(5);

        let asking = Incoming::Permission(PermissionRequest {
            id: 9,
            summary: "Run `rm -rf /`".to_string(),
        });
        assert_eq!(tracker.observe(&asking), Some(AgentStatus::NeedsInput));

        tracker.permission_answered(9);
        assert_eq!(
            tracker.status(),
            AgentStatus::Running,
            "answering hands the turn back to the agent, it does not end it"
        );

        assert_eq!(
            tracker.observe(&Incoming::Response { id: 5 }),
            Some(AgentStatus::Idle)
        );
    }

    #[test]
    fn several_permissions_all_have_to_be_answered() {
        let mut tracker = StatusTracker::new();
        tracker.prompt_sent(5);
        for id in [9, 10] {
            tracker.observe(&Incoming::Permission(PermissionRequest {
                id,
                summary: String::new(),
            }));
        }

        tracker.permission_answered(9);
        assert_eq!(
            tracker.status(),
            AgentStatus::NeedsInput,
            "one answer does not clear the other"
        );

        tracker.permission_answered(10);
        assert_eq!(tracker.status(), AgentStatus::Running);
    }

    #[test]
    fn only_a_change_is_reported() {
        // The reader calls this per line; reporting every line would put a status
        // update on the event system for every chunk of an agent's output.
        let mut tracker = StatusTracker::new();
        tracker.prompt_sent(5);

        assert_eq!(tracker.observe(&Incoming::Ignored), None);
        assert_eq!(tracker.observe(&Incoming::Ignored), None);
    }

    #[test]
    fn the_handshake_asks_for_v1_and_reports_the_session_it_is_given() {
        let mut sent = Vec::new();
        // Deliberately noisy, and out of order: the agent's reply to `initialize`
        // and anything else on stdout arrive before the one being waited for.
        let replies = concat!(
            "not json at all\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"sessionId\":\"sess_abc\"}}\n",
        );
        let mut reader = BufReader::new(replies.as_bytes());

        let session = handshake(&mut sent, &mut reader, std::path::Path::new("/tmp/acme"))
            .expect("the handshake should complete");

        assert_eq!(session, "sess_abc");
        let written = String::from_utf8(sent).unwrap();
        assert!(written.contains(r#""protocolVersion":"1""#));
        assert!(written.contains(r#""method":"initialize""#));
        assert!(written.contains(r#""method":"session/new""#));
        assert!(written.contains("/tmp/acme"));
        assert_eq!(
            written.lines().count(),
            2,
            "one JSON object per line, since that is what the transport reads"
        );
    }

    #[test]
    fn an_agent_that_exits_during_the_handshake_says_so() {
        let mut sent = Vec::new();
        let mut reader = BufReader::new(&b""[..]);

        let error = handshake(&mut sent, &mut reader, std::path::Path::new("/tmp")).unwrap_err();

        assert!(
            error.to_string().contains("exited"),
            "the message has to name the real cause, got: {error}"
        );
    }

    #[test]
    fn a_refused_session_is_an_error_rather_than_a_missing_id() {
        let mut sent = Vec::new();
        let replies = "{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32000,\"message\":\"not signed in\"}}\n";
        let mut reader = BufReader::new(replies.as_bytes());

        let error = handshake(&mut sent, &mut reader, std::path::Path::new("/tmp")).unwrap_err();

        assert!(error.to_string().contains("not signed in"));
    }

    #[test]
    fn the_reader_reports_transitions_and_then_the_close() {
        use std::sync::mpsc;

        let tracker = Arc::new(Mutex::new(StatusTracker::new()));
        lock(&tracker).prompt_sent(5);

        let (statuses, seen) = mpsc::channel();
        let (permissions, asked) = mpsc::channel();
        let (closed, ended) = mpsc::channel();

        let lines = concat!(
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{}}\n",
            "{\"id\":9,\"method\":\"session/request_permission\",\"params\":{\"toolCall\":{\"title\":\"Write a file\"}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{\"stopReason\":\"end_turn\"}}\n",
        );

        read_loop(
            BufReader::new(lines.as_bytes()),
            Arc::clone(&tracker),
            Callbacks {
                on_status: Box::new(move |status| {
                    let _ = statuses.send(status);
                }),
                on_permission: Box::new(move |request| {
                    let _ = permissions.send(request);
                }),
                on_closed: Box::new(move || {
                    let _ = closed.send(());
                }),
            },
        );

        assert_eq!(asked.recv().unwrap().summary, "Write a file");
        assert_eq!(seen.recv().unwrap(), AgentStatus::NeedsInput);
        // The prompt's reply arrives while the permission is still outstanding, so
        // the session is not idle and nothing further is reported.
        assert!(
            seen.try_recv().is_err(),
            "an unanswered permission still outranks the finished turn"
        );
        assert_eq!(lock(&tracker).status(), AgentStatus::NeedsInput);
        ended.recv().expect("the close should be reported");
    }
}
