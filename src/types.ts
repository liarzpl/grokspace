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

/**
 * A terminal session only ever reports `running` or `stopped`: a pty carries
 * pixels, and pixels cannot say what the process inside is doing. All four are
 * reachable for an `agent`, which GrokSpace drives over ACP — see
 * docs/grok-cli-integration.md for why those cannot be the same session.
 */
export type SessionStatus = "idle" | "running" | "needs_input" | "stopped";

/**
 * `grok` runs an agent as a terminal, `shell` the user's login shell, and `agent`
 * the same Grok Build over ACP with no terminal at all — which is what buys the
 * richer status. An agent holds no pane.
 */
export type SessionKind = "grok" | "shell" | "agent";

/**
 * Something an agent is blocked on. It does nothing further until this is
 * answered, which is what `needs_input` means.
 */
export interface PermissionRequest {
  /** The id to answer with; the agent is waiting on this exact one. */
  requestId: number;
  summary: string;
}

export interface Session {
  id: string;
  projectId: string;
  paneId: string | null;
  processId: number | null;
  status: SessionStatus;
  title: string | null;
  role: string | null;
  worktreePath: string | null;
  kind: SessionKind;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A session's graph file as the backend found it. The JSON is handed over
 * unparsed: the schema is a model's output, so `lib/graph.ts` is the one place
 * that decides what a usable graph is.
 */
export interface GraphSnapshot {
  sessionId: string;
  /** The file that was read, or the one that is expected to appear. */
  path: string;
  exists: boolean;
  /**
   * Absent when the file is missing, present but still empty, or refused for its
   * size.
   */
  json: string | null;
  /**
   * True when the file was too big to read, which is a different report than no
   * graph yet: the file is there, it just will not be opened.
   */
  tooLarge: boolean;
  updatedAt: number | null;
}

/** Whether the skill that teaches `grok` to write graph files is in place. */
export interface SkillStatus {
  path: string;
  installed: boolean;
  /** False when an older GrokSpace installed a different version of the skill. */
  current: boolean;
}

/** Grid presets, named columns-by-rows. Freeform splits are a later phase. */
export type PaneLayout = "1x1" | "2x1" | "2x2" | "3x2";

export const PANE_LAYOUTS: readonly PaneLayout[] = ["1x1", "2x1", "2x2", "3x2"];

export const DEFAULT_LAYOUT: PaneLayout = "2x2";

export function paneCount(layout: PaneLayout): number {
  const [cols, rows] = layout.split("x").map(Number);
  return (cols ?? 1) * (rows ?? 1);
}

export type MemoryEntryType = "note" | "decision" | "context" | "artifact";

export interface MemoryEntry {
  projectId: string;
  key: string;
  content: string;
  type: MemoryEntryType;
  updatedAt: number;
}
