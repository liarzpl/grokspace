/**
 * Mirrors the Rust structs in `src-tauri/src/`, which serialize as camelCase.
 * `Task`, `Session`, and `MemoryEntry` already have tables in migration 0001;
 * they are declared here so Phases 1-3 extend these types instead of redefining
 * the data model.
 */

export type ProjectSettings = Record<string, unknown>;

export interface Project {
  id: string;
  name: string;
  path: string;
  /** Milliseconds since the Unix epoch, or null if never opened. */
  lastOpened: number | null;
  settings: ProjectSettings;
  createdAt: number;
}

export type TaskStatus = "backlog" | "in_progress" | "review" | "done";

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignedSessionId: string | null;
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export type SessionStatus = "idle" | "running" | "needs_input" | "stopped";

export interface Session {
  id: string;
  projectId: string;
  paneId: string | null;
  processId: number | null;
  status: SessionStatus;
  title: string | null;
  role: string | null;
  worktreePath: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MemoryEntryType = "note" | "decision" | "context" | "artifact";

export interface MemoryEntry {
  projectId: string;
  key: string;
  content: string;
  type: MemoryEntryType;
  updatedAt: number;
}
