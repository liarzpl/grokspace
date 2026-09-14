//! ACP child process: handshake, status tracker, and the stdio reader.

use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{json, Value};

use super::protocol::{
    classify, coalesce_update, json_rpc_id, permission_reply, AgentStatus, AgentUpdate, Incoming,
    PermissionOption, PermissionRequest,
};
use crate::error::{Error, Result};

/// The ACP revision `grok` speaks. Its own documented client example sends this,
/// and it matters: `state_update`, which would have answered the status question
/// directly, only exists from v2 onwards.
const PROTOCOL_VERSION: u16 = 1;

/// How long the opening handshake may take before the agent is called unusable.
/// Generous, because a first run can be doing a token refresh, but finite: a
/// silent agent must not hang the command that started it.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Recovered from rather than propagated, for the reason `pty.rs` gives: nothing in
/// here guards an invariant a panic could break, and losing an agent because an
/// unrelated thread panicked would be the worse outcome.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
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

    /// Drops in-flight prompts. Cancel asks the agent to stop the turn; if it
    /// honors that without a prompt reply, status would otherwise stay Running.
    /// Outstanding permissions stay: those still need an answer.
    pub fn cancel_prompts(&mut self) {
        self.prompts.clear();
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
pub(crate) struct Agent {
    pub(crate) stdin: Mutex<ChildStdin>,
    pub(crate) child: Mutex<Child>,
    pub(crate) tracker: Arc<Mutex<StatusTracker>>,
    pub(crate) next_id: AtomicU64,
    /// The id ACP gave the conversation, which every session-scoped call needs.
    pub(crate) acp_session: String,
    pub(crate) process_id: Option<u32>,
    pub(crate) on_status: Arc<dyn Fn(AgentStatus) + Send + Sync>,
}

#[derive(Default)]
pub struct AcpManager {
    pub(crate) agents: Mutex<HashMap<String, Arc<Agent>>>,
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
        // Parent env is inherited on purpose: `grok agent` reads `XAI_API_KEY`.
        // Shell panes strip that key in the pty layer; this path must not.
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
    ///
    /// `option_id` is the extra chip (Always allow / Always deny). Primary
    /// Allow/Deny leave it unset and map to `allow_once` / `reject_once` only.
    pub fn answer_permission(
        &self,
        id: &str,
        request_id: u64,
        allow: bool,
        option_id: Option<&str>,
    ) -> Result<()> {
        let agent = self.agent(id)?;
        let (rpc_id, options) = {
            let tracker = lock(&agent.tracker);
            (
                tracker.rpc_id_for(request_id),
                tracker.options_for(request_id),
            )
        };
        let reply = permission_reply(&rpc_id, allow, &options, option_id)?;

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
        )?;
        drop(stdin);

        // Recorded only once cancel is out, so a failed write cannot leave the
        // session idle while the agent never saw the interrupt.
        let changed = {
            let mut tracker = lock(&agent.tracker);
            let before = tracker.status();
            tracker.cancel_prompts();
            let after = tracker.status();
            (after != before).then_some(after)
        };
        if let Some(status) = changed {
            (agent.on_status)(status);
        }
        Ok(())
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

/// The ids the handshake may use (`initialize`, optional `authenticate`,
/// `session/new`), so a prompt can never collide with them.
pub(crate) const HANDSHAKE_IDS: u64 = 3;

/// Auth methods GrokSpace can finish without a terminal. Device-code would hang
/// waiting on a browser this process does not drive.
pub(crate) const AUTH_CACHED_TOKEN: &str = "cached_token";
pub(crate) const AUTH_API_KEY: &str = "xai.api_key";

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

/// `initialize`, then `authenticate` when the agent listed a method we can
/// finish, then `session/new`.
///
/// Split out so it can be driven against a scripted agent in the tests rather
/// than only against the real binary. `session/new` is not sent until
/// initialize (and authenticate, when it ran) has succeeded: a refused
/// protocol must not look like an open session. Device-code is not faked —
/// that would hang waiting on a browser this process does not have.
pub(crate) fn handshake(
    stdin: &mut impl Write,
    reader: &mut impl BufRead,
    cwd: &std::path::Path,
) -> Result<String> {
    handshake_with(stdin, reader, cwd, xai_api_key_present())
}

pub(crate) fn handshake_with(
    stdin: &mut impl Write,
    reader: &mut impl BufRead,
    cwd: &std::path::Path,
    prefer_api_key: bool,
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
                // never comes. `auth.terminal` is not one of those: GrokSpace
                // has no ACP terminal to drive a device-code login.
                "clientCapabilities": {},
                "clientInfo": {
                    "name": "grokspace",
                    "title": "GrokSpace",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            },
        }),
    )?;
    let initialized = wait_for_reply(reader, 1, "the agent refused to initialize")?;

    let mut rpc_id = 2u64;
    if let Some(method_id) = auth_method_to_use(&initialized, prefer_api_key)? {
        write_message(
            stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "method": "authenticate",
                "params": { "methodId": method_id },
            }),
        )?;
        wait_for_reply(reader, rpc_id, "the agent refused to authenticate")?;
        rpc_id += 1;
    }

    write_message(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": rpc_id,
            "method": "session/new",
            "params": { "cwd": cwd.to_string_lossy(), "mcpServers": [] },
        }),
    )?;
    let opened = wait_for_reply(reader, rpc_id, "the agent refused a session")?;
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

fn xai_api_key_present() -> bool {
    std::env::var("XAI_API_KEY").is_ok_and(|value| !value.trim().is_empty())
}

fn auth_required_error() -> Error {
    Error::Pty(
        "the agent requires authentication GrokSpace cannot complete. Run grok login first.".into(),
    )
}

/// Picks `cached_token` or `xai.api_key` from initialize's `authMethods`.
/// Empty or absent means no authenticate step. Anything else is a hard stop.
fn auth_method_to_use(initialized: &Value, prefer_api_key: bool) -> Result<Option<&'static str>> {
    let Some(methods) = initialized
        .get("result")
        .and_then(|result| result.get("authMethods"))
        .and_then(Value::as_array)
    else {
        return Ok(None);
    };
    if methods.is_empty() {
        return Ok(None);
    }
    let ids: Vec<&str> = methods
        .iter()
        .filter_map(|method| method.get("id").and_then(Value::as_str))
        .filter(|id| !id.is_empty())
        .collect();
    choose_auth_method(&ids, prefer_api_key)
}

pub(crate) fn choose_auth_method(
    ids: &[&str],
    prefer_api_key: bool,
) -> Result<Option<&'static str>> {
    if ids.is_empty() {
        return Err(auth_required_error());
    }
    let has_cached = ids.contains(&AUTH_CACHED_TOKEN);
    let has_api_key = ids.contains(&AUTH_API_KEY);
    if !has_cached && !has_api_key {
        return Err(auth_required_error());
    }
    // Grok's own client: the API key when `XAI_API_KEY` is set, otherwise
    // the cached login token.
    if prefer_api_key && has_api_key {
        Ok(Some(AUTH_API_KEY))
    } else if has_cached {
        Ok(Some(AUTH_CACHED_TOKEN))
    } else {
        Ok(Some(AUTH_API_KEY))
    }
}

/// Reads until a JSON-RPC reply with `expected_id` arrives. Other lines are
/// ignored: initialize, authenticate, and session/new share stdout with
/// notifications.
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
pub(crate) fn read_loop(
    mut reader: impl BufRead,
    tracker: Arc<Mutex<StatusTracker>>,
    callbacks: Callbacks,
) {
    let mut line = String::new();
    let mut pending: Option<AgentUpdate> = None;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }

        let incoming = classify(&line);
        match &incoming {
            Incoming::Update(update) => {
                if let Some(ready) = coalesce_update(&mut pending, update.clone()) {
                    (callbacks.on_update)(ready);
                }
            }
            other => {
                if let Some(ready) = pending.take() {
                    (callbacks.on_update)(ready);
                }
                if let Incoming::Permission(request) = other {
                    (callbacks.on_permission)(request.clone());
                }
            }
        }
        let changed = lock(&tracker).observe(&incoming);
        if let Some(status) = changed {
            (callbacks.on_status)(status);
        }
    }
    if let Some(ready) = pending.take() {
        (callbacks.on_update)(ready);
    }
    (callbacks.on_closed)();
}
