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
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{Error, Result};

/// The ACP revision `grok` speaks. Its own documented client example sends this,
/// and it matters: `state_update`, which would have answered the status question
/// directly, only exists from v2 onwards.
const PROTOCOL_VERSION: &str = "1";

/// How long the opening handshake may take before the agent is called unusable.
/// Generous, because a first run can be doing a token refresh, but finite: a
/// silent agent must not hang the command that started it.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

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

/// One choice the agent offered on a permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: String,
    pub kind: String,
    pub name: String,
}

/// A permission the agent is waiting on, surfaced so it can be put to the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRequest {
    /// Numeric form used to key the tracker and the frontend.
    pub id: u64,
    /// The JSON-RPC id exactly as the agent sent it, so the reply can echo it.
    pub rpc_id: Value,
    /// What the agent wants to do, in whatever words it used.
    pub summary: String,
    /// The options the agent listed; the reply must pick one of these ids.
    pub options: Vec<PermissionOption>,
}

/// One visible thing the agent said during a turn. Status does not depend on
/// these; the frontend does, because an ACP session has no pane to watch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdate {
    pub kind: UpdateKind,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKind {
    Message,
    Thought,
    Tool,
    Plan,
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
    /// Output the UI can show: a message chunk, a thought, a tool, or a plan.
    Update(AgentUpdate),
    Ignored,
}

/// JSON-RPC ids are a number or a string. ACP permission requests from Grok are
/// numbers; numeric strings are accepted so a reply can still be correlated.
fn json_rpc_id(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| value.as_str()?.parse().ok())
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

    let rpc_id = message.get("id").cloned();
    let id = rpc_id.as_ref().and_then(json_rpc_id);
    let method = message.get("method").and_then(Value::as_str);

    match (method, id, rpc_id) {
        // A request from the agent: it has both a method and an id, and it is
        // waiting for an answer.
        (Some("session/request_permission"), Some(id), Some(rpc_id)) => {
            Incoming::Permission(PermissionRequest {
                id,
                rpc_id,
                summary: permission_summary(&message),
                options: permission_options(&message),
            })
        }
        (Some("session/update"), _, _) => parse_session_update(&message)
            .map(Incoming::Update)
            .unwrap_or(Incoming::Ignored),
        // A reply to us: an id and no method.
        (None, Some(id), _) => Incoming::Response { id },
        _ => Incoming::Ignored,
    }
}

/// Pulls a displayable line out of `session/update`. Most of the schema is still
/// Ignored — available commands, usage, mode — because nothing in the UI draws it.
fn parse_session_update(message: &Value) -> Option<AgentUpdate> {
    let params = message.get("params")?;
    // Spec puts the payload under `params.update`; a flatter shape is accepted
    // so a slightly different agent still shows up rather than going silent.
    let update = params.get("update").unwrap_or(params);
    let kind = update.get("sessionUpdate")?.as_str()?;
    match kind {
        "agent_message_chunk" => Some(AgentUpdate {
            kind: UpdateKind::Message,
            text: content_text(update)?,
        }),
        "agent_thought_chunk" => Some(AgentUpdate {
            kind: UpdateKind::Thought,
            text: content_text(update)?,
        }),
        "tool_call" | "tool_call_update" => Some(AgentUpdate {
            kind: UpdateKind::Tool,
            text: tool_text(update)?,
        }),
        "plan" => Some(AgentUpdate {
            kind: UpdateKind::Plan,
            text: plan_text(update)?,
        }),
        _ => None,
    }
}

fn content_text(update: &Value) -> Option<String> {
    let content = update.get("content")?;
    let text = content
        .as_str()
        .map(str::to_string)
        .or_else(|| content.get("text").and_then(Value::as_str).map(str::to_string))?;
    let text = text.trim_end_matches('\0').to_string();
    (!text.is_empty()).then_some(text)
}

fn tool_text(update: &Value) -> Option<String> {
    for key in ["title", "kind", "status"] {
        if let Some(text) = update.get(key).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return Some(text.trim().to_string());
            }
        }
    }
    None
}

fn plan_text(update: &Value) -> Option<String> {
    let entries = update.get("entries")?.as_array()?;
    let lines: Vec<String> = entries
        .iter()
        .filter_map(|entry| {
            let content = entry.get("content")?.as_str()?.trim();
            if content.is_empty() {
                return None;
            }
            let status = entry
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            Some(format!("{status} {content}"))
        })
        .collect();
    (!lines.is_empty()).then_some(lines.join("\n"))
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

fn permission_options(message: &Value) -> Vec<PermissionOption> {
    message
        .get("params")
        .and_then(|params| params.get("options"))
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    let option_id = option.get("optionId")?.as_str()?.to_string();
                    if option_id.is_empty() {
                        return None;
                    }
                    Some(PermissionOption {
                        option_id,
                        kind: option
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        name: option
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The JSON-RPC `result` for a permission reply, matching ACP v1.
///
/// Deny selects a reject option. `cancelled` means the prompt turn was cancelled,
/// which is not what Allow/Deny on a card means.
pub fn permission_result(allow: bool, options: &[PermissionOption]) -> Result<Value> {
    let option = pick_option(allow, options).ok_or_else(|| {
        Error::Invalid("the agent offered no permission option that matches the answer".into())
    })?;
    Ok(json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option.option_id,
        }
    }))
}

fn pick_option(allow: bool, options: &[PermissionOption]) -> Option<&PermissionOption> {
    if options.is_empty() {
        return None;
    }
    let preferred: &[&str] = if allow {
        &["allow_once", "allow_always"]
    } else {
        &["reject_once", "reject_always"]
    };
    for kind in preferred {
        if let Some(option) = options.iter().find(|option| option.kind == *kind) {
            return Some(option);
        }
    }
    // No kinds at all: the first option is the only honest guess. Mixed kinds
    // with nothing matching would pick the wrong allow/deny, so that is refused.
    if options.iter().all(|option| option.kind.is_empty()) {
        options.first()
    } else {
        None
    }
}

fn permission_reply(rpc_id: &Value, allow: bool, options: &[PermissionOption]) -> Result<Value> {
    Ok(json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": permission_result(allow, options)?,
    }))
}

/// What the flow says the session is doing.
///
/// ACP v1 has no status message, so this is derived rather than read: a prompt we
/// sent and have had no reply to means work is happening, and a permission request
/// we have not answered outranks it, because nothing moves until it is answered.
#[derive(Debug, Default)]
pub struct StatusTracker {
    prompts: BTreeSet<u64>,
    permissions: BTreeSet<u64>,
    options: HashMap<u64, Vec<PermissionOption>>,
    rpc_ids: HashMap<u64, Value>,
}

impl StatusTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> AgentStatus {
        if !self.permissions.is_empty() {
            AgentStatus::NeedsInput
        } else if !self.prompts.is_empty() {
            AgentStatus::Running
        } else {
            AgentStatus::Idle
        }
    }

    /// Records that a prompt has gone out and is awaiting its reply.
    pub fn prompt_sent(&mut self, id: u64) {
        self.prompts.insert(id);
    }

    /// Records an answer to a permission request, which unblocks the agent.
    pub fn permission_answered(&mut self, id: u64) {
        self.permissions.remove(&id);
        self.options.remove(&id);
        self.rpc_ids.remove(&id);
    }

    fn options_for(&self, id: u64) -> Vec<PermissionOption> {
        self.options.get(&id).cloned().unwrap_or_default()
    }

    fn rpc_id_for(&self, id: u64) -> Value {
        self.rpc_ids.get(&id).cloned().unwrap_or_else(|| json!(id))
    }

    /// Folds one incoming message in. Returns the status if it changed, so a
    /// caller can report transitions rather than every line.
    pub fn observe(&mut self, incoming: &Incoming) -> Option<AgentStatus> {
        let before = self.status();
        match incoming {
            Incoming::Permission(request) => {
                self.permissions.insert(request.id);
                self.options.insert(request.id, request.options.clone());
                self.rpc_ids.insert(request.id, request.rpc_id.clone());
            }
            Incoming::Response { id } => {
                // Only a reply to a prompt we sent ends that turn. Replies to the
                // handshake arrive first and mean nothing about the conversation.
                // A second in-flight prompt must not steal the first's id.
                self.prompts.remove(id);
            }
            Incoming::Update(_) | Incoming::Ignored => {}
        }
        let after = self.status();
        (after != before).then_some(after)
    }
}

/// What a live agent reports, on the reader thread.
pub struct Callbacks {
    pub on_status: Arc<dyn Fn(AgentStatus) + Send + Sync>,
    pub on_permission: Box<dyn Fn(PermissionRequest) + Send + Sync>,
    pub on_update: Arc<dyn Fn(AgentUpdate) + Send + Sync>,
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
    on_status: Arc<dyn Fn(AgentStatus) + Send + Sync>,
}

#[derive(Default)]
pub struct AcpManager {
    agents: Mutex<HashMap<String, Arc<Agent>>>,
}

fn kill_and_wait(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
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
        self.start_with_timeout(options, callbacks, HANDSHAKE_TIMEOUT)
    }

    /// Same as [`Self::start`], with a timeout the tests can shrink so a hanging
    /// child is not a thirty-second wait.
    pub(crate) fn start_with_timeout(
        &self,
        options: StartOptions,
        callbacks: Callbacks,
        timeout: Duration,
    ) -> Result<Option<u32>> {
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
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                kill_and_wait(&mut child);
                return Err(Error::Pty("the agent has no stdin".into()));
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                kill_and_wait(&mut child);
                return Err(Error::Pty("the agent has no stdout".into()));
            }
        };

        let cwd = options.cwd.clone();
        let (tx, rx) = mpsc::channel();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("acp-handshake-{}", options.id))
            .spawn(move || {
                let mut stdin = stdin;
                let mut reader = BufReader::new(stdout);
                let result = handshake(&mut stdin, &mut reader, &cwd).map(|id| (id, stdin, reader));
                let _ = tx.send(result);
            })
        {
            kill_and_wait(&mut child);
            return Err(Error::Pty(format!(
                "could not start the agent handshake: {error}"
            )));
        }

        // The handshake's own reads can block forever on a silent pipe. Bounding
        // the wait here, then killing the child, is what makes the timeout real:
        // a dead child is what unblocks `read_line`.
        let (acp_session, stdin, reader) = match rx.recv_timeout(timeout) {
            Ok(Ok(handshake)) => handshake,
            Ok(Err(error)) => {
                kill_and_wait(&mut child);
                return Err(error);
            }
            Err(_) => {
                kill_and_wait(&mut child);
                return Err(Error::Pty(
                    "the agent did not answer the ACP handshake in time".into(),
                ));
            }
        };

        let on_status = Arc::clone(&callbacks.on_status);
        let agent = Arc::new(Agent {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            tracker: Arc::new(Mutex::new(StatusTracker::new())),
            next_id: AtomicU64::new(HANDSHAKE_IDS + 1),
            acp_session,
            process_id,
            on_status,
        });

        let tracker = Arc::clone(&agent.tracker);
        if let Err(error) = std::thread::Builder::new()
            .name(format!("acp-read-{}", options.id))
            .spawn(move || read_loop(reader, tracker, callbacks))
        {
            kill_and_wait(&mut lock(&agent.child));
            return Err(Error::Pty(format!(
                "could not start the agent reader: {error}"
            )));
        }

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
        )?;
        drop(stdin);

        // Recorded only once the prompt is out, so a failed write cannot leave
        // the session reading as running while the agent never saw the turn.
        let changed = {
            let mut tracker = lock(&agent.tracker);
            let before = tracker.status();
            tracker.prompt_sent(request_id);
            let after = tracker.status();
            (after != before).then_some(after)
        };
        if let Some(status) = changed {
            (agent.on_status)(status);
        }
        Ok(())
    }

    /// Answers a permission request, which is what lets the agent carry on.
    pub fn answer_permission(&self, id: &str, request_id: u64, allow: bool) -> Result<()> {
        let agent = self.agent(id)?;
        let (rpc_id, options) = {
            let tracker = lock(&agent.tracker);
            (
                tracker.rpc_id_for(request_id),
                tracker.options_for(request_id),
            )
        };
        let reply = permission_reply(&rpc_id, allow, &options)?;

        let mut stdin = lock(&agent.stdin);
        let sent = write_message(&mut *stdin, &reply);
        drop(stdin);
        // Recorded only once the answer is out, so a failed write cannot leave the
        // session reading as answered while the agent is still waiting.
        if sent.is_ok() {
            let changed = {
                let mut tracker = lock(&agent.tracker);
                let before = tracker.status();
                tracker.permission_answered(request_id);
                let after = tracker.status();
                (after != before).then_some(after)
            };
            if let Some(status) = changed {
                (agent.on_status)(status);
            }
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
        kill_and_wait(&mut lock(&agent.child));
        Ok(())
    }

    /// Forgets the agent, which drops its stdin and lets the reader see the end.
    ///
    /// `try_wait` reaps a child that has already exited (or that `kill` already
    /// waited on) so Drop cannot leave a zombie.
    pub fn remove(&self, id: &str) {
        if let Some(agent) = lock(&self.agents).remove(id) {
            let _ = lock(&agent.child).try_wait();
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        lock(&self.agents).contains_key(id)
    }

    /// Ends every agent, so none outlives the window it was reporting to.
    pub fn shutdown(&self) {
        let mut agents = lock(&self.agents);
        for agent in agents.values() {
            kill_and_wait(&mut lock(&agent.child));
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
/// than only against the real binary. `session/new` is not sent until initialize
/// has succeeded: a refused protocol must not look like an open session.
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
    wait_for_reply(reader, 1, "the agent refused to initialize")?;

    write_message(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": { "cwd": cwd.to_string_lossy(), "mcpServers": [] },
        }),
    )?;
    let opened = wait_for_reply(reader, 2, "the agent refused a session")?;
    if let Some(session) = opened
        .get("result")
        .and_then(|result| result.get("sessionId"))
        .and_then(Value::as_str)
    {
        return Ok(session.to_string());
    }
    Err(Error::Pty(
        "the agent opened a session without giving it an id".into(),
    ))
}

/// Reads until a JSON-RPC reply with `expected_id` arrives. Other lines are
/// ignored: initialize and session/new share stdout with notifications.
fn wait_for_reply(
    reader: &mut impl BufRead,
    expected_id: u64,
    error_prefix: &str,
) -> Result<Value> {
    let mut line = String::new();
    loop {
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
        if json_rpc_id(message.get("id").unwrap_or(&Value::Null)) != Some(expected_id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(Error::Pty(format!("{error_prefix}: {error}")));
        }
        return Ok(message);
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
        if let Incoming::Update(update) = &incoming {
            (callbacks.on_update)(update.clone());
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
    use std::time::Instant;

    fn v1_options() -> Vec<PermissionOption> {
        vec![
            PermissionOption {
                option_id: "allow-once".into(),
                kind: "allow_once".into(),
                name: "Allow once".into(),
            },
            PermissionOption {
                option_id: "reject-once".into(),
                kind: "reject_once".into(),
                name: "Reject".into(),
            },
        ]
    }

    fn perm(id: u64, summary: &str) -> PermissionRequest {
        PermissionRequest {
            id,
            rpc_id: json!(id),
            summary: summary.to_string(),
            options: Vec::new(),
        }
    }

    fn noop_callbacks() -> Callbacks {
        Callbacks {
            on_status: Arc::new(|_| {}),
            on_permission: Box::new(|_| {}),
            on_update: Arc::new(|_| {}),
            on_closed: Box::new(|| {}),
        }
    }

    fn install_test_agent(
        manager: &AcpManager,
        id: &str,
        stdin: ChildStdin,
        child: Child,
        on_status: Arc<dyn Fn(AgentStatus) + Send + Sync>,
    ) -> Arc<Mutex<StatusTracker>> {
        let tracker = Arc::new(Mutex::new(StatusTracker::new()));
        lock(&manager.agents).insert(
            id.to_string(),
            Arc::new(Agent {
                stdin: Mutex::new(stdin),
                child: Mutex::new(child),
                tracker: Arc::clone(&tracker),
                next_id: AtomicU64::new(HANDSHAKE_IDS + 1),
                acp_session: "sess_test".into(),
                process_id: None,
                on_status,
            }),
        );
        tracker
    }

    fn spawn_cat() -> (Child, ChildStdin) {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("cat should start");
        let stdin = child.stdin.take().expect("cat has stdin");
        (child, stdin)
    }

    fn pid_is_alive(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

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
    fn a_numeric_string_id_is_still_a_request() {
        let incoming =
            classify(r#"{"jsonrpc":"2.0","id":"9","method":"session/request_permission"}"#);
        let Incoming::Permission(request) = incoming else {
            panic!("a string id that is a number should still classify as a permission");
        };
        assert_eq!(request.id, 9);
        assert_eq!(request.rpc_id, json!("9"));
    }

    #[test]
    fn a_notification_and_a_stray_line_are_both_ignored() {
        // An empty session/update has nothing to show, and stdout is shared with
        // whatever else decides to print.
        assert_eq!(
            classify(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#),
            Incoming::Ignored
        );
        assert_eq!(classify("warning: something unrelated"), Incoming::Ignored);
        assert_eq!(classify(""), Incoming::Ignored);
    }

    #[test]
    fn a_thought_chunk_and_a_flat_payload_are_updates() {
        let nested = classify(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}}}"#,
        );
        assert_eq!(
            nested,
            Incoming::Update(AgentUpdate {
                kind: UpdateKind::Thought,
                text: "hmm".into(),
            })
        );

        // Spec nests under `params.update`; a flatter agent still has to show up.
        let flat = classify(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":"hello"}}"#,
        );
        assert_eq!(
            flat,
            Incoming::Update(AgentUpdate {
                kind: UpdateKind::Message,
                text: "hello".into(),
            })
        );
    }

    #[test]
    fn an_empty_message_chunk_is_ignored() {
        assert_eq!(
            classify(
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":""}}}}"#
            ),
            Incoming::Ignored
        );
    }

    #[test]
    fn a_message_chunk_is_an_update_rather_than_ignored() {
        let incoming = classify(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}"#,
        );
        assert_eq!(
            incoming,
            Incoming::Update(AgentUpdate {
                kind: UpdateKind::Message,
                text: "hello".into(),
            })
        );
    }

    #[test]
    fn a_tool_call_and_a_plan_are_readable_updates() {
        let tool = classify(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","title":"Read src/lib.rs"}}}"#,
        );
        assert_eq!(
            tool,
            Incoming::Update(AgentUpdate {
                kind: UpdateKind::Tool,
                text: "Read src/lib.rs".into(),
            })
        );

        let plan = classify(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[{"content":"Find the leak","status":"in_progress"},{"content":"Write a test","status":"pending"}]}}}"#,
        );
        let Incoming::Update(update) = plan else {
            panic!("a plan is visible output");
        };
        assert_eq!(update.kind, UpdateKind::Plan);
        assert!(update.text.contains("Find the leak"));
        assert!(update.text.contains("Write a test"));
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
                rpc_id: json!(1),
                summary: "Run `git push`".to_string(),
                options: Vec::new(),
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
    fn a_permission_request_keeps_the_options_the_agent_offered() {
        let incoming = classify(
            r#"{"jsonrpc":"2.0","id":5,"method":"session/request_permission","params":{
                "options":[
                    {"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
                    {"optionId":"reject-once","name":"Reject","kind":"reject_once"}
                ]
            }}"#,
        );
        let Incoming::Permission(request) = incoming else {
            panic!("expected a permission");
        };
        assert_eq!(request.options, v1_options());
    }

    #[test]
    fn allow_selects_the_nested_v1_outcome_and_the_request_option_id() {
        // The published ACP v1 example, not a flattened guess.
        assert_eq!(
            permission_reply(&json!(5), true, &v1_options()).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 5,
                "result": {
                    "outcome": {
                        "outcome": "selected",
                        "optionId": "allow-once"
                    }
                }
            })
        );
    }

    #[test]
    fn deny_selects_a_reject_option_rather_than_cancelling_the_turn() {
        assert_eq!(
            permission_reply(&json!(5), false, &v1_options()).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 5,
                "result": {
                    "outcome": {
                        "outcome": "selected",
                        "optionId": "reject-once"
                    }
                }
            })
        );
    }

    #[test]
    fn the_option_id_is_read_from_the_request_not_assumed() {
        let options = vec![PermissionOption {
            option_id: "allow-this-run".into(),
            kind: "allow_once".into(),
            name: "Allow".into(),
        }];
        let result = permission_result(true, &options).unwrap();
        assert_eq!(result["outcome"]["optionId"], json!("allow-this-run"));
        assert_ne!(result["outcome"]["optionId"], json!("allow"));
    }

    #[test]
    fn a_string_rpc_id_is_echoed_rather_than_rewritten_as_a_number() {
        let reply = permission_reply(&json!("9"), true, &v1_options()).unwrap();
        assert_eq!(reply["id"], json!("9"));
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
    fn a_second_prompt_does_not_drop_the_first() {
        let mut tracker = StatusTracker::new();
        tracker.prompt_sent(5);
        tracker.prompt_sent(6);

        assert_eq!(
            tracker.observe(&Incoming::Response { id: 5 }),
            None,
            "the other prompt is still in flight"
        );
        assert_eq!(tracker.status(), AgentStatus::Running);
        assert_eq!(
            tracker.observe(&Incoming::Response { id: 6 }),
            Some(AgentStatus::Idle)
        );
    }

    #[test]
    fn an_unanswered_permission_outranks_the_work_it_interrupted() {
        // Nothing moves until it is answered, so reporting `running` would be a
        // terminal that looks busy while it waits on a person.
        let mut tracker = StatusTracker::new();
        tracker.prompt_sent(5);

        let asking = Incoming::Permission(perm(9, "Run `rm -rf /`"));
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
            tracker.observe(&Incoming::Permission(perm(id, "")));
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
        let replies = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32000,\"message\":\"not signed in\"}}\n",
        );
        let mut reader = BufReader::new(replies.as_bytes());

        let error = handshake(&mut sent, &mut reader, std::path::Path::new("/tmp")).unwrap_err();

        assert!(error.to_string().contains("not signed in"));
    }

    #[test]
    fn a_refused_initialize_does_not_open_a_session() {
        let mut sent = Vec::new();
        let replies =
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32600,\"message\":\"unknown protocol\"}}\n";
        let mut reader = BufReader::new(replies.as_bytes());

        let error = handshake(&mut sent, &mut reader, std::path::Path::new("/tmp")).unwrap_err();

        assert!(error.to_string().contains("unknown protocol"));
        let written = String::from_utf8(sent).unwrap();
        assert!(
            !written.contains(r#""method":"session/new""#),
            "session/new must not be sent after initialize failed"
        );
    }

    #[test]
    fn the_reader_reports_transitions_and_then_the_close() {
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
                on_status: Arc::new(move |status| {
                    let _ = statuses.send(status);
                }),
                on_permission: Box::new(move |request| {
                    let _ = permissions.send(request);
                }),
                on_update: Arc::new(|_| {}),
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

    #[test]
    fn the_reader_reports_visible_updates() {
        let tracker = Arc::new(Mutex::new(StatusTracker::new()));
        let (updates, seen) = mpsc::channel();

        let lines = concat!(
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"hi\"}}}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{}}\n",
        );

        read_loop(
            BufReader::new(lines.as_bytes()),
            Arc::clone(&tracker),
            Callbacks {
                on_status: Arc::new(|_| {}),
                on_permission: Box::new(|_| {}),
                on_update: Arc::new(move |update| {
                    let _ = updates.send(update);
                }),
                on_closed: Box::new(|| {}),
            },
        );

        assert_eq!(
            seen.recv().unwrap(),
            AgentUpdate {
                kind: UpdateKind::Message,
                text: "hi".into(),
            }
        );
        assert!(
            seen.try_recv().is_err(),
            "an empty session/update is not visible output"
        );
    }

    #[test]
    fn answering_a_permission_reports_running_and_sends_the_v1_shape() {
        let (tx, rx) = mpsc::channel();
        let manager = AcpManager::new();
        let (child, stdin) = spawn_cat();
        let tracker = install_test_agent(
            &manager,
            "a1",
            stdin,
            child,
            Arc::new(move |status| {
                let _ = tx.send(status);
            }),
        );

        lock(&tracker).prompt_sent(5);
        lock(&tracker).observe(&Incoming::Permission(PermissionRequest {
            id: 9,
            rpc_id: json!(9),
            summary: "Write a file".into(),
            options: v1_options(),
        }));
        assert_eq!(lock(&tracker).status(), AgentStatus::NeedsInput);

        manager.answer_permission("a1", 9, true).unwrap();

        assert_eq!(rx.recv().unwrap(), AgentStatus::Running);
        assert_eq!(lock(&tracker).status(), AgentStatus::Running);
        manager.kill("a1").ok();
        manager.remove("a1");
    }

    #[test]
    fn a_failed_prompt_does_not_leave_the_session_running() {
        let mut child = Command::new("true")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("true should start");
        let stdin = child.stdin.take().expect("true has stdin");
        let _ = child.wait();

        let manager = AcpManager::new();
        let tracker = install_test_agent(&manager, "a1", stdin, child, Arc::new(|_| {}));

        let error = manager.prompt("a1", "do the work").unwrap_err();
        assert!(error.to_string().contains("could not write"));
        assert_eq!(
            lock(&tracker).status(),
            AgentStatus::Idle,
            "a prompt that never left must not look like work in flight"
        );
        manager.remove("a1");
    }

    #[test]
    fn killing_an_agent_reaps_the_child() {
        let (child, stdin) = spawn_cat();
        let pid = child.id();
        let manager = AcpManager::new();
        install_test_agent(&manager, "a1", stdin, child, Arc::new(|_| {}));

        manager.kill("a1").unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !pid_is_alive(pid),
            "kill must wait so the child cannot linger as a zombie"
        );
        manager.remove("a1");
    }

    #[test]
    fn a_silent_agent_is_killed_when_the_handshake_times_out() {
        let dir = tempfile::tempdir().expect("temp dir");
        let script = dir.path().join("hang");
        let pid_file = dir.path().join("pid");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho $$ > {}\nwhile true; do sleep 1; done\n",
                pid_file.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let manager = AcpManager::new();
        let started = Instant::now();
        let error = manager
            .start_with_timeout(
                StartOptions {
                    id: "hang".into(),
                    program: script.to_string_lossy().into_owned(),
                    cwd: dir.path().to_path_buf(),
                    env: Vec::new(),
                },
                noop_callbacks(),
                Duration::from_millis(400),
            )
            .unwrap_err();

        assert!(error.to_string().contains("in time"), "got: {error}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the timeout must not wait on a blocking read of a silent pipe"
        );
        assert!(!manager.is_running("hang"));

        let pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap_or_default()
            .trim()
            .parse()
            .expect("the hang script should have written its pid");
        // A moment for wait() to reap; kill -0 must then fail.
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !pid_is_alive(pid),
            "the hanging child must not outlive a failed handshake"
        );
    }
}
