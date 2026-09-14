//! Driving a Grok agent over ACP instead of over a terminal.
//!
//! `grok agent stdio` speaks JSON-RPC on stdin and stdout rather than rendering a
//! TUI. [`protocol`] classifies lines; [`process`] owns the child, handshake, and
//! status tracker.

mod process;
mod protocol;

// Re-exported for session/start and the frontend IPC types; unused in this file.
#[allow(unused_imports)]
pub use process::{AcpManager, Callbacks, StartOptions, StatusTracker};
#[allow(unused_imports)]
pub use protocol::{
    classify, AgentStatus, AgentUpdate, Incoming, PermissionOption, PermissionRequest, UpdateKind,
};

#[cfg(test)]
mod tests {
    use super::process::{
        choose_auth_method, handshake, handshake_with, lock, read_loop, Agent, AUTH_API_KEY,
        AUTH_CACHED_TOKEN, HANDSHAKE_IDS,
    };
    use super::protocol::{coalesce_update, permission_choice, permission_reply, UPDATE_TEXT_CAP};
    use super::*;
    use crate::error::Result;
    use serde_json::{json, Value};
    use std::io::BufReader;
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::atomic::AtomicU64;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

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
    fn a_message_chunk_longer_than_the_cap_is_truncated() {
        let huge = "x".repeat(UPDATE_TEXT_CAP + 64);
        let line = format!(
            r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{huge}"}}}}}}}}"#
        );
        let Incoming::Update(update) = classify(&line) else {
            panic!("a long chunk is still an update");
        };
        assert_eq!(update.text.len(), UPDATE_TEXT_CAP);
        assert!(update.text.chars().all(|c| c == 'x'));
    }

    #[test]
    fn consecutive_same_kind_chunks_coalesce_under_the_cap() {
        let mut pending = None;
        assert_eq!(
            coalesce_update(
                &mut pending,
                AgentUpdate {
                    kind: UpdateKind::Message,
                    text: "hel".into(),
                },
            ),
            None
        );
        assert_eq!(
            coalesce_update(
                &mut pending,
                AgentUpdate {
                    kind: UpdateKind::Message,
                    text: "lo".into(),
                },
            ),
            None
        );
        assert_eq!(
            pending,
            Some(AgentUpdate {
                kind: UpdateKind::Message,
                text: "hello".into(),
            })
        );
    }

    #[test]
    fn a_kind_change_flushes_the_coalesced_chunk() {
        let mut pending = Some(AgentUpdate {
            kind: UpdateKind::Message,
            text: "hello".into(),
        });
        let flushed = coalesce_update(
            &mut pending,
            AgentUpdate {
                kind: UpdateKind::Thought,
                text: "hmm".into(),
            },
        );
        assert_eq!(
            flushed,
            Some(AgentUpdate {
                kind: UpdateKind::Message,
                text: "hello".into(),
            })
        );
        assert_eq!(
            pending,
            Some(AgentUpdate {
                kind: UpdateKind::Thought,
                text: "hmm".into(),
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

    fn permission_result(allow: bool, options: &[PermissionOption]) -> Result<Value> {
        permission_choice(allow, options, None)
    }

    #[test]
    fn allow_selects_the_nested_v1_permission_outcome_and_the_request_option_id() {
        // The published ACP v1 example, not a flattened guess.
        assert_eq!(
            permission_reply(&json!(5), true, &v1_options(), None).unwrap(),
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
    fn deny_selects_a_reject_once_permission_rather_than_cancelling_the_turn() {
        let reply = permission_reply(&json!(5), false, &v1_options(), None).unwrap();
        assert_eq!(
            reply,
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
        assert_ne!(reply["result"]["outcome"]["outcome"], json!("cancelled"));
    }

    #[test]
    fn allow_with_only_allow_always_sends_no_permission_option() {
        let options = vec![PermissionOption {
            option_id: "allow-always".into(),
            kind: "allow_always".into(),
            name: "Always allow".into(),
        }];
        let error = permission_result(true, &options).unwrap_err();
        assert!(
            error.to_string().contains("no permission option"),
            "got: {error}"
        );
    }

    #[test]
    fn allow_picks_the_allow_once_permission_not_allow_always() {
        let options = vec![
            PermissionOption {
                option_id: "allow-always".into(),
                kind: "allow_always".into(),
                name: "Always allow".into(),
            },
            PermissionOption {
                option_id: "allow-once".into(),
                kind: "allow_once".into(),
                name: "Allow once".into(),
            },
        ];
        let result = permission_result(true, &options).unwrap();
        assert_eq!(result["outcome"]["optionId"], json!("allow-once"));
    }

    #[test]
    fn empty_permission_kinds_are_not_guessed_as_allow() {
        let options = vec![PermissionOption {
            option_id: "first".into(),
            kind: String::new(),
            name: "Sure".into(),
        }];
        assert!(permission_result(true, &options).is_err());
        assert!(permission_result(false, &options).is_err());
    }

    #[test]
    fn deny_does_not_fall_back_to_a_reject_always_permission() {
        let options = vec![PermissionOption {
            option_id: "reject-always".into(),
            kind: "reject_always".into(),
            name: "Always reject".into(),
        }];
        assert!(permission_result(false, &options).is_err());
    }

    #[test]
    fn an_explicit_permission_option_id_selects_allow_always() {
        let options = vec![PermissionOption {
            option_id: "allow-always".into(),
            kind: "allow_always".into(),
            name: "Always allow".into(),
        }];
        assert!(permission_result(true, &options).is_err());
        let result = permission_choice(true, &options, Some("allow-always")).unwrap();
        assert_eq!(result["outcome"]["optionId"], json!("allow-always"));
        assert_eq!(result["outcome"]["outcome"], json!("selected"));
    }

    #[test]
    fn the_permission_option_id_is_read_from_the_request_not_assumed() {
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
        let reply = permission_reply(&json!("9"), true, &v1_options(), None).unwrap();
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
    fn cancel_clears_in_flight_prompts() {
        let mut tracker = StatusTracker::new();
        tracker.prompt_sent(5);
        tracker.cancel_prompts();
        assert_eq!(
            tracker.status(),
            AgentStatus::Idle,
            "cancel ends the turn even when grok never replies to the prompt"
        );
    }

    #[test]
    fn cancel_leaves_an_unanswered_permission() {
        let mut tracker = StatusTracker::new();
        tracker.prompt_sent(5);
        tracker.observe(&Incoming::Permission(perm(9, "Write a file")));
        tracker.cancel_prompts();
        assert_eq!(
            tracker.status(),
            AgentStatus::NeedsInput,
            "a blocked permission still has to be answered"
        );
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
        assert!(written.contains(r#""protocolVersion":1"#));
        assert!(
            !written.contains(r#""protocolVersion":"1""#),
            "protocolVersion must be an integer, not a string"
        );
        assert!(written.contains("clientInfo"));
        assert!(written.contains("grokspace"));
        assert!(written.contains(r#""method":"initialize""#));
        assert!(written.contains(r#""method":"session/new""#));
        assert!(
            !written.contains(r#""method":"authenticate""#),
            "absent authMethods must not insert an authenticate step"
        );
        assert!(written.contains(r#""clientCapabilities":{}"#));
        assert!(
            !written.contains("terminal"),
            "clientCapabilities must not claim auth.terminal"
        );
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

    fn handshake_rpc_methods(sent: &[u8]) -> Vec<String> {
        String::from_utf8_lossy(sent)
            .lines()
            .filter_map(|line| {
                serde_json::from_str::<Value>(line)
                    .ok()?
                    .get("method")?
                    .as_str()
                    .map(str::to_string)
            })
            .collect()
    }

    #[test]
    fn empty_auth_methods_still_complete_the_handshake() {
        let mut sent = Vec::new();
        let replies = concat!(
            r#"{"jsonrpc":"2.0","id":1,"result":{"authMethods":[]}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess_open"}}"#,
            "\n",
        );
        let mut reader = BufReader::new(replies.as_bytes());

        let session = handshake(&mut sent, &mut reader, std::path::Path::new("/tmp"))
            .expect("an empty authMethods list is not a login wall");

        assert_eq!(session, "sess_open");
        assert_eq!(handshake_rpc_methods(&sent), ["initialize", "session/new"]);
    }

    #[test]
    fn the_handshake_rejects_device_code_and_does_not_open_a_session() {
        let mut sent = Vec::new();
        let replies =
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"authMethods\":[{\"id\":\"device-code\"}]}}\n";
        let mut reader = BufReader::new(replies.as_bytes());

        let error = handshake(&mut sent, &mut reader, std::path::Path::new("/tmp")).unwrap_err();

        assert!(
            error.to_string().contains("Run grok login first"),
            "the user has to be told what to do, got: {error}"
        );
        let written = String::from_utf8(sent).unwrap();
        assert!(
            !written.contains(r#""method":"session/new""#),
            "session/new must not be sent when authenticate cannot be finished"
        );
        assert!(
            !written.contains(r#""method":"authenticate""#),
            "device-code must not be faked over ACP"
        );
    }

    #[test]
    fn the_handshake_authenticates_with_a_cached_token_before_opening_a_session() {
        let mut sent = Vec::new();
        let replies = concat!(
            r#"{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"cached_token"}]}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"result":{}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"result":{"sessionId":"sess_auth"}}"#,
            "\n",
        );
        let mut reader = BufReader::new(replies.as_bytes());

        let session = handshake(&mut sent, &mut reader, std::path::Path::new("/tmp"))
            .expect("cached_token is an authenticate method GrokSpace can finish");

        assert_eq!(session, "sess_auth");
        let messages: Vec<Value> = String::from_utf8(sent)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            messages
                .iter()
                .filter_map(|message| message.get("method").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            ["initialize", "authenticate", "session/new"]
        );
        assert_eq!(messages[1]["id"], json!(2));
        assert_eq!(messages[1]["params"]["methodId"], json!("cached_token"));
        assert_eq!(messages[2]["id"], json!(3));
        assert_eq!(messages[0]["params"]["clientCapabilities"], json!({}));
        assert!(messages[0]["params"]["clientCapabilities"]
            .get("auth")
            .is_none());
    }

    #[test]
    fn the_handshake_authenticates_with_an_api_key_when_that_is_what_was_offered() {
        let mut sent = Vec::new();
        let replies = concat!(
            r#"{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"xai.api_key"}]}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"result":{}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"result":{"sessionId":"sess_key"}}"#,
            "\n",
        );
        let mut reader = BufReader::new(replies.as_bytes());

        let session = handshake_with(&mut sent, &mut reader, std::path::Path::new("/tmp"), false)
            .expect("xai.api_key is an authenticate method GrokSpace can finish");

        assert_eq!(session, "sess_key");
        let written = String::from_utf8(sent).unwrap();
        assert!(written.contains(r#""method":"authenticate""#));
        assert!(written.contains(r#""methodId":"xai.api_key""#));
        assert!(written.contains(r#""method":"session/new""#));
    }

    #[test]
    fn the_handshake_prefers_the_api_key_when_that_env_is_set() {
        let mut sent = Vec::new();
        let replies = concat!(
            r#"{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"cached_token"},{"id":"xai.api_key"}]}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"result":{}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":3,"result":{"sessionId":"sess_pref"}}"#,
            "\n",
        );
        let mut reader = BufReader::new(replies.as_bytes());

        handshake_with(&mut sent, &mut reader, std::path::Path::new("/tmp"), true)
            .expect("either offered method is finishable");

        let authenticate =
            serde_json::from_str::<Value>(String::from_utf8(sent).unwrap().lines().nth(1).unwrap())
                .unwrap();
        assert_eq!(authenticate["params"]["methodId"], json!("xai.api_key"));
    }

    #[test]
    fn a_refused_authenticate_does_not_finish_the_handshake() {
        let mut sent = Vec::new();
        let replies = concat!(
            r#"{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"cached_token"}]}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"token expired"}}"#,
            "\n",
        );
        let mut reader = BufReader::new(replies.as_bytes());

        let error = handshake(&mut sent, &mut reader, std::path::Path::new("/tmp")).unwrap_err();

        assert!(error.to_string().contains("token expired"));
        let written = String::from_utf8(sent).unwrap();
        assert!(
            !written.contains(r#""method":"session/new""#),
            "session/new must not be sent after authenticate failed"
        );
    }

    #[test]
    fn choose_auth_method_for_the_handshake_prefers_cached_token_without_an_api_key() {
        assert_eq!(
            choose_auth_method(&["cached_token", "xai.api_key"], false).unwrap(),
            Some(AUTH_CACHED_TOKEN)
        );
        assert_eq!(
            choose_auth_method(&["cached_token", "xai.api_key"], true).unwrap(),
            Some(AUTH_API_KEY)
        );
        assert_eq!(
            choose_auth_method(&["device-code", "cached_token"], false).unwrap(),
            Some(AUTH_CACHED_TOKEN)
        );
        let error = choose_auth_method(&["device-code"], false).unwrap_err();
        assert!(error.to_string().contains("Run grok login first"));
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

        manager.answer_permission("a1", 9, true, None).unwrap();

        assert_eq!(rx.recv().unwrap(), AgentStatus::Running);
        assert_eq!(lock(&tracker).status(), AgentStatus::Running);
        manager.kill("a1").ok();
        manager.remove("a1");
    }

    #[test]
    fn cancel_reports_idle_when_a_prompt_is_in_flight() {
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
        manager.cancel("a1").unwrap();

        assert_eq!(rx.recv().unwrap(), AgentStatus::Idle);
        assert_eq!(lock(&tracker).status(), AgentStatus::Idle);
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
