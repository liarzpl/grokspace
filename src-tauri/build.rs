/// Invoke commands registered in `lib.rs` `generate_handler!`.
///
/// Listing them here turns off Tauri's implicit allow-all for app commands
/// and generates `allow-<kebab>` / `deny-<kebab>` permissions. The main
/// window must then name each `allow-*` in `capabilities/default.json`.
const APP_COMMANDS: &[&str] = &[
    "log_client_error",
    "list_projects",
    "open_project",
    "update_project",
    "touch_project",
    "remove_project",
    "list_sessions",
    "create_session",
    "attach_session",
    "write_session",
    "resize_session",
    "stop_session",
    "restart_session",
    "rename_session",
    "close_session",
    "discard_session_worktree",
    "merge_session_worktree",
    "session_merge_readiness",
    "prompt_session",
    "cancel_session",
    "answer_session_permission",
    "list_memory",
    "put_memory",
    "remove_memory",
    "memory_file_path",
    "skill_status",
    "install_skill",
    "list_tasks",
    "create_task",
    "update_task",
    "dispatch_task",
    "undispatch_task",
    "remove_task",
    "project_diff",
    "file_diff",
    "reveal_artifact",
    "read_settings",
    "write_setting",
    "read_permission_policy",
    "write_permission_policy",
    "read_session_graph",
    "watch_project_graphs",
    "list_session_steps",
    "add_session_step",
    "update_session_step",
    "remove_session_step",
    "reorder_session_steps",
    "approve_session_steps",
    "reopen_session_steps",
    "watch_project_steps",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Tauri application context");
}
