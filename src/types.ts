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
  /** Permission prompts still waiting; filled by `listSessions` after a reload. */
  pendingPermissions?: PermissionRequest[];
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

/** What happened to one file, in the words `git status` uses. */
export type FileChange = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  path: string;
  change: FileChange;
}

/**
 * What the diff panel has to draw, as one of four things it can honestly say.
 *
 * A union rather than a struct of optionals: "git is missing" and "nothing has
 * changed" are different sentences, and a `files: []` that meant either would leave
 * the panel guessing.
 */
export type DiffState =
  | { state: "gitMissing" }
  | { state: "notARepo" }
  | { state: "clean"; branch: string | null }
  | { state: "changed"; branch: string | null; files: ChangedFile[] };

/**
 * Preferences that belong to the app rather than to one project. Missing keys read
 * as their defaults, so an older database needs no backfill.
 */
export interface Settings {
  /** The pane layout a project that has never chosen one gets. */
  defaultLayout: PaneLayout;
  /** The panel the workspace opens on. */
  openingTab: "terminals" | "graph" | "tasks" | "memory" | "diff";
  /**
   * Which new session a dispatch reaches for first. Only the order of the offer
   * changes, so nothing is chosen on anyone's behalf — but it decides which chip is
   * nearest the pointer, and for someone who always dispatches the same way that is
   * the difference between one click and seven.
   */
  defaultDispatch: "pane" | "agent";
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

/**
 * The layout a project falls back to when nothing else has an opinion.
 *
 * Both the frontend's settings store and `settings.rs` name the same value, and this
 * is the third place it appears — kept because the fallback chain has to end
 * somewhere that does not depend on a preference having loaded.
 */
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
