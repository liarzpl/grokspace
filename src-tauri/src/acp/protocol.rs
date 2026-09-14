//! ACP JSON-RPC lines: classify, visible updates, permission replies.
//!
//! Process spawn and the handshake live in [`super`].

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};

/// One `session/update` chunk, and a coalesced run of the same kind, stay
/// under this many bytes. The frontend still folds entries; this stops a
/// single token stream from growing without bound on the event bus.
pub(crate) const UPDATE_TEXT_CAP: usize = 8 * 1024;

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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
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
pub(crate) fn json_rpc_id(value: &Value) -> Option<u64> {
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
    let text = content.as_str().map(str::to_string).or_else(|| {
        content
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
    })?;
    let text = text.trim_end_matches('\0').to_string();
    let text = cap_text(&text);
    (!text.is_empty()).then_some(text)
}

fn cap_text(text: &str) -> String {
    if text.len() <= UPDATE_TEXT_CAP {
        return text.to_string();
    }
    let mut end = UPDATE_TEXT_CAP;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Folds `next` into `pending` when they are the same kind and still under
/// the cap. Returns the update that must be emitted now, if any.
pub(crate) fn coalesce_update(
    pending: &mut Option<AgentUpdate>,
    next: AgentUpdate,
) -> Option<AgentUpdate> {
    match pending.as_mut() {
        Some(last)
            if last.kind == next.kind
                && last.text.len().saturating_add(next.text.len()) <= UPDATE_TEXT_CAP =>
        {
            last.text.push_str(&next.text);
            None
        }
        Some(_) => pending.replace(next),
        None => {
            *pending = Some(next);
            None
        }
    }
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
/// Deny selects `reject_once`. `cancelled` means the prompt turn was cancelled,
/// which is not what Allow/Deny on a card means. Allow never selects
/// `allow_always`; that is a separate named chip.
pub(crate) fn permission_choice(
    allow: bool,
    options: &[PermissionOption],
    option_id: Option<&str>,
) -> Result<Value> {
    let option = match option_id {
        Some(id) => options.iter().find(|option| option.option_id == id),
        None => pick_option(allow, options),
    };
    let option = option.ok_or_else(|| {
        Error::Invalid("the agent offered no permission option that matches the answer".into())
    })?;
    Ok(json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option.option_id,
        }
    }))
}

/// Primary Allow is `allow_once` only. `allow_always` is a separate chip the
/// user has to pick by name; folding it into Allow is the silent
/// `--always-approve` bug. Empty kinds are not guessed as Allow.
fn pick_option(allow: bool, options: &[PermissionOption]) -> Option<&PermissionOption> {
    let wanted = if allow { "allow_once" } else { "reject_once" };
    options.iter().find(|option| option.kind == wanted)
}

pub(crate) fn permission_reply(
    rpc_id: &Value,
    allow: bool,
    options: &[PermissionOption],
    option_id: Option<&str>,
) -> Result<Value> {
    Ok(json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": permission_choice(allow, options, option_id)?,
    }))
}
