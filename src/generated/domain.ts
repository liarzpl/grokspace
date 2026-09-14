/**
 * Generated from the Rust domain enums. Do not edit.
 * `cargo test domain::generated_typescript_is_current` fails when this is stale.
 */

export const PANE_LAYOUTS = ["1x1", "2x1", "2x2", "3x2"] as const;
export const DEFAULT_LAYOUT = "2x2" as const;

export const WORKSPACE_TABS = ["terminals", "graph", "tasks", "memory", "diff"] as const;
export const DEFAULT_TAB = "terminals" as const;

export const DISPATCH_TARGETS = ["pane", "agent"] as const;
export const DEFAULT_DISPATCH = "pane" as const;

export const WORKTREE_SETUP = ["off", "on"] as const;
export const DEFAULT_WORKTREE_SETUP = "off" as const;

export const SESSION_STATUSES = ["idle", "running", "needs_input", "stopped"] as const;
export const SESSION_KINDS = ["grok", "shell", "agent"] as const;
export const TASK_STATUSES = ["backlog", "in_progress", "review", "done"] as const;
export const STEPS_PHASES = ["none", "proposed", "approved"] as const;
export const STEP_STATUSES = ["pending", "doing", "done", "skipped"] as const;
export const STEP_ORIGINS = ["agent", "user"] as const;
export const MEMORY_ENTRY_TYPES = ["note", "decision", "context", "artifact"] as const;
