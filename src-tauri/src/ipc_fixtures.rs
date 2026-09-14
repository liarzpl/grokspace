//! TEST-003: locked IPC JSON for [`Session`](crate::session::Session) and
//! [`Task`](crate::task::Task).
//!
//! `#74` already covers event names. These fixtures are the bodies
//! `list_sessions` / `list_tasks` send: camelCase keys, pending permissions,
//! and `isolationSkip`. A rename of `worktreePath`, `assignedSessionId`, or
//! `requestId` fails here instead of in the webview.

use crate::acp::PermissionOption;
use crate::session::{PendingPermission, Session, SessionKind, SessionStatus};
use crate::task::{Task, TaskStatus};
use serde_json::{json, Value};

const SESSION_KEYS: &[&str] = &[
    "id",
    "projectId",
    "paneId",
    "processId",
    "status",
    "title",
    "role",
    "worktreePath",
    "isolationSkip",
    "kind",
    "exitCode",
    "createdAt",
    "updatedAt",
    "pendingPermissions",
];

const PERMISSION_KEYS: &[&str] = &["requestId", "summary", "options"];

const OPTION_KEYS: &[&str] = &["optionId", "name", "kind"];

const TASK_KEYS: &[&str] = &[
    "id",
    "projectId",
    "title",
    "description",
    "status",
    "assignedSessionId",
    "priority",
    "createdAt",
    "updatedAt",
];

fn session_fixture() -> Value {
    json!({
        "id": "s1",
        "projectId": "p1",
        "paneId": null,
        "processId": 4242,
        "status": "needs_input",
        "title": "Coder",
        "role": "Coder",
        "worktreePath": "/tmp/acme/.grokspace/worktrees/s1",
        "isolationSkip": "this folder is not a git repository",
        "kind": "agent",
        "exitCode": null,
        "createdAt": 1000,
        "updatedAt": 2000,
        "pendingPermissions": [{
            "requestId": 9,
            "summary": "Write a file",
            "options": [{
                "optionId": "allow-once",
                "name": "Allow once",
                "kind": "allow_once"
            }]
        }]
    })
}

fn task_fixture() -> Value {
    json!({
        "id": "t1",
        "projectId": "p1",
        "title": "Fix the login bug",
        "description": "Ship the board",
        "status": "in_progress",
        "assignedSessionId": "s1",
        "priority": 5,
        "createdAt": 1000,
        "updatedAt": 2000
    })
}

fn populated_session() -> Session {
    Session {
        id: "s1".into(),
        project_id: "p1".into(),
        pane_id: None,
        process_id: Some(4242),
        status: SessionStatus::NeedsInput,
        title: Some("Coder".into()),
        role: Some("Coder".into()),
        worktree_path: Some("/tmp/acme/.grokspace/worktrees/s1".into()),
        isolation_skip: Some("this folder is not a git repository".into()),
        kind: SessionKind::Agent,
        exit_code: None,
        created_at: 1000,
        updated_at: 2000,
        pending_permissions: vec![PendingPermission {
            request_id: 9,
            summary: "Write a file".into(),
            options: vec![PermissionOption {
                option_id: "allow-once".into(),
                name: "Allow once".into(),
                kind: "allow_once".into(),
            }],
        }],
    }
}

fn populated_task() -> Task {
    Task {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "Fix the login bug".into(),
        description: Some("Ship the board".into()),
        status: TaskStatus::InProgress,
        assigned_session_id: Some("s1".into()),
        priority: 5,
        created_at: 1000,
        updated_at: 2000,
    }
}

fn sorted_keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value
        .as_object()
        .unwrap_or_else(|| panic!("expected object, got {value}"))
        .keys()
        .cloned()
        .collect();
    keys.sort();
    keys
}

fn owned(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|key| (*key).to_string()).collect()
}

fn assert_keys(value: &Value, expected: &[&str]) {
    let mut expected = owned(expected);
    expected.sort();
    assert_eq!(sorted_keys(value), expected, "json: {value}");
}

fn round_trip<T>(value: &Value) -> Value
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let parsed: T = serde_json::from_value(value.clone()).expect("fixture should deserialize");
    serde_json::to_value(&parsed).expect("round-trip should serialize")
}

fn types_ts() -> String {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/types.ts");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()))
}

fn strip_block_comments(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        match rest.find("*/") {
            Some(end) => {
                out.push(' ');
                rest = &rest[end + 2..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn interface_fields(source: &str, name: &str) -> Vec<String> {
    let header = format!("export interface {name} {{");
    let start = source
        .find(&header)
        .unwrap_or_else(|| panic!("types.ts is missing `{header}`"));
    let after = &source[start + header.len()..];
    let mut depth = 1usize;
    let mut end = 0usize;
    for (index, ch) in after.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = index;
                    break;
                }
            }
            _ => {}
        }
    }
    strip_block_comments(&after[..end])
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("//") {
                return None;
            }
            let field: String = trimmed
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
                .collect();
            (!field.is_empty()).then_some(field)
        })
        .collect()
}

#[test]
fn session_ipc_fixture_round_trips() {
    let fixture = session_fixture();
    assert_keys(&fixture, SESSION_KEYS);
    assert_keys(&fixture["pendingPermissions"][0], PERMISSION_KEYS);
    assert_keys(&fixture["pendingPermissions"][0]["options"][0], OPTION_KEYS);

    let back = round_trip::<Session>(&fixture);
    assert_eq!(back, fixture);
    assert_eq!(
        serde_json::to_value(populated_session()).expect("serialize"),
        fixture
    );
}

#[test]
fn session_ipc_fixture_keeps_omitted_permissions_empty() {
    let mut fixture = session_fixture();
    fixture
        .as_object_mut()
        .expect("session object")
        .remove("pendingPermissions");

    let parsed: Session = serde_json::from_value(fixture).expect("permissions default to empty");
    assert!(parsed.pending_permissions.is_empty());

    let back = serde_json::to_value(&parsed).expect("serialize");
    assert_eq!(back["pendingPermissions"], json!([]));
    assert_keys(&back, SESSION_KEYS);
}

#[test]
fn session_ipc_fixture_rejects_snake_case_keys() {
    let snake = json!({
        "id": "s1",
        "project_id": "p1",
        "pane_id": null,
        "process_id": 4242,
        "status": "needs_input",
        "title": "Coder",
        "role": "Coder",
        "worktree_path": "/tmp/acme/.grokspace/worktrees/s1",
        "isolation_skip": "this folder is not a git repository",
        "kind": "agent",
        "exit_code": null,
        "created_at": 1000,
        "updated_at": 2000,
        "pending_permissions": [{
            "request_id": 9,
            "summary": "Write a file",
            "options": [{
                "option_id": "allow-once",
                "name": "Allow once",
                "kind": "allow_once"
            }]
        }]
    });
    assert!(
        serde_json::from_value::<Session>(snake).is_err(),
        "IPC Session is camelCase; snake_case must not deserialize"
    );
}

#[test]
fn task_ipc_fixture_round_trips() {
    let fixture = task_fixture();
    assert_keys(&fixture, TASK_KEYS);

    let back = round_trip::<Task>(&fixture);
    assert_eq!(back, fixture);
    assert_eq!(
        serde_json::to_value(populated_task()).expect("serialize"),
        fixture
    );
}

#[test]
fn task_ipc_fixture_rejects_snake_case_keys() {
    let snake = json!({
        "id": "t1",
        "project_id": "p1",
        "title": "Fix the login bug",
        "description": "Ship the board",
        "status": "in_progress",
        "assigned_session_id": "s1",
        "priority": 5,
        "created_at": 1000,
        "updated_at": 2000
    });
    assert!(
        serde_json::from_value::<Task>(snake).is_err(),
        "IPC Task is camelCase; snake_case must not deserialize"
    );
}

#[test]
fn session_and_task_keys_match_types_ts() {
    let source = types_ts();
    assert_eq!(interface_fields(&source, "Session"), owned(SESSION_KEYS));
    assert_eq!(
        interface_fields(&source, "PermissionRequest"),
        owned(PERMISSION_KEYS)
    );
    assert_eq!(
        interface_fields(&source, "PermissionOption"),
        owned(OPTION_KEYS)
    );
    assert_eq!(interface_fields(&source, "Task"), owned(TASK_KEYS));
}
