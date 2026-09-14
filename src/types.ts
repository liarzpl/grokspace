/**
 * Mirrors the Rust structs in `src-tauri/src/`, which serialize as camelCase.
 * New fields land here beside the Rust type rather than as a second model.
 *
 * Enum string lists come from `generated/domain.ts`, which `src-tauri/src/domain.rs`
 * emits. The comments stay here; the allowed values do not.
 */

import {
  DEFAULT_DISPATCH,
  DEFAULT_LAYOUT,
  DEFAULT_TAB,
  DEFAULT_WORKTREE_SETUP,
  DISPATCH_TARGETS,
  MEMORY_ENTRY_TYPES,
  PANE_LAYOUTS,
  SESSION_KINDS,
  SESSION_STATUSES,
  STEP_ORIGINS,
  STEP_STATUSES,
  STEPS_PHASES,
  TASK_STATUSES,
  WORKSPACE_TABS,
  WORKTREE_SETUP,
} from "./generated/domain";

export {
  DEFAULT_DISPATCH,
  DEFAULT_LAYOUT,
  DEFAULT_TAB,
  DEFAULT_WORKTREE_SETUP,
  DISPATCH_TARGETS,
  MEMORY_ENTRY_TYPES,
  PANE_LAYOUTS,
  SESSION_KINDS,
  SESSION_STATUSES,
  STEP_ORIGINS,
  STEP_STATUSES,
  STEPS_PHASES,
  TASK_STATUSES,
  WORKSPACE_TABS,
  WORKTREE_SETUP,
};

/** Per-project prefs. Only known keys; a typo must not persist as a silent fallback. */
export interface ProjectSettings {
  terminalLayout?: PaneLayout;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  /** Milliseconds since the Unix epoch, or null if never opened. */
  lastOpened: number | null;
  settings: ProjectSettings;
  createdAt: number;
}

export type TaskStatus = (typeof TASK_STATUSES)[number];

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
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * `grok` runs an agent as a terminal, `shell` the user's login shell, and `agent`
 * the same Grok Build over ACP with no terminal at all — which is what buys the
 * richer status. An agent holds no pane.
 */
export type SessionKind = (typeof SESSION_KINDS)[number];

/** One choice the agent listed on a permission request. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/**
 * Something an agent is blocked on. It does nothing further until this is
 * answered, which is what `needs_input` means.
 */
export interface PermissionRequest {
  /** The id to answer with; the agent is waiting on this exact one. */
  requestId: number;
  summary: string;
  /** The choices the agent listed. Allow uses only `allow_once`. */
  options?: PermissionOption[];
}

/** User-authored globs in `~/.grokspace/permission-policy.json`. */
export const PERMISSION_POLICY_ACTIONS = ["deny", "ask", "allow-once-similar"] as const;
export type PermissionPolicyAction = (typeof PERMISSION_POLICY_ACTIONS)[number];

export interface PermissionPolicyRule {
  action: PermissionPolicyAction;
  pattern: string;
}

export interface PermissionPolicy {
  path: string;
  projectFile: string;
  rules: PermissionPolicyRule[];
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
  /** Why isolation was skipped; set on the session row so a reload keeps it. */
  isolationSkip?: string | null;
  kind: SessionKind;
  exitCode: number | null;
  createdAt: number;
  updatedAt: number;
  /** Permission prompts still waiting; filled by `listSessions` after a reload. */
  pendingPermissions?: PermissionRequest[];
}

/**
 * `merge_session_worktree` after the branch has landed. `teardownError` is set
 * when only worktree removal failed — the session already has a null path.
 */
export interface MergeOutcome {
  session: Session;
  teardownError?: string | null;
}

/**
 * One visible thing an ACP agent said. `prompt` is GrokSpace's own, recorded
 * when a follow-up is sent; the rest arrive as `session-update` events.
 */
export type AgentUpdateKind = "message" | "thought" | "tool" | "plan" | "prompt";

export interface AgentUpdate {
  kind: AgentUpdateKind;
  text: string;
}

/**
 * One item on a session's working list. Distinct from a board `Task`: these are
 * the breakdown the agent proposes for this run, not cards you dispatch.
 */
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Whether the list is still being edited, or locked after Approve. */
export type StepsPhase = (typeof STEPS_PHASES)[number];

export type StepOrigin = (typeof STEP_ORIGINS)[number];

export interface SessionStep {
  id: string;
  sessionId: string;
  sortIndex: number;
  title: string;
  status: StepStatus;
  origin: StepOrigin;
  createdAt: number;
  updatedAt: number;
}

export interface SessionSteps {
  sessionId: string;
  phase: StepsPhase;
  steps: SessionStep[];
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

/**
 * The project's cross-session edges file. JSON is handed over unparsed:
 * `lib/edges.ts` decides what a usable document is. Not a session graph.
 */
export interface EdgesSnapshot {
  path: string;
  exists: boolean;
  json: string | null;
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
 * Another tree that also touched a path. `sessionId` is null when the other
 * side is the project itself.
 */
export interface OverlapPeer {
  sessionId: string | null;
  title: string | null;
}

/** A path the tree on screen shares with at least one other tree. */
export interface PathOverlap {
  path: string;
  peers: OverlapPeer[];
  /** Lockfiles and migrations: the same warning, a louder sentence. */
  hotspot: boolean;
}

/**
 * What the diff panel has to draw, as one of four things it can honestly say.
 *
 * A union rather than a struct of optionals: "git is missing" and "nothing has
 * changed" are different sentences, and a `files: []` that meant either would leave
 * the panel guessing.
 *
 * `overlaps` is a warning list, not a lock. Absent on older payloads and on
 * git-missing / not-a-repo, where there is nothing to compare.
 */
export type DiffState =
  | { state: "gitMissing" }
  | { state: "notARepo" }
  | { state: "clean"; branch: string | null; overlaps?: PathOverlap[] }
  | { state: "changed"; branch: string | null; files: ChangedFile[]; overlaps?: PathOverlap[] };

/**
 * The panels the workspace switches between while working. Settings' opening tab
 * is this same list: a preference that named a sixth panel would be a control
 * that cannot open anything.
 */
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export type OpeningTab = WorkspaceTab;
export type DispatchTarget = (typeof DISPATCH_TARGETS)[number];
export type RunWorktreeSetup = (typeof WORKTREE_SETUP)[number];

/**
 * Preferences that belong to the app rather than to one project. Missing keys read
 * as their defaults, so an older database needs no backfill.
 */
export interface Settings {
  /** The pane layout a project that has never chosen one gets. */
  defaultLayout: PaneLayout;
  /** The panel the workspace opens on. */
  openingTab: OpeningTab;
  /**
   * Which new session a dispatch reaches for first. Only the order of the offer
   * changes, so nothing is chosen on anyone's behalf — but it decides which chip is
   * nearest the pointer, and for someone who always dispatches the same way that is
   * the difference between one click and seven.
   */
  defaultDispatch: DispatchTarget;
  /**
   * Run `<project>/.grokspace/worktree-setup` (or `setup` in `worktrees.json`)
   * after a fresh isolated checkout. Off by default — a script is code.
   */
  runWorktreeSetup: RunWorktreeSetup;
}

/** The value `writeSetting` will accept for a given key. */
export type SettingValue<K extends keyof Settings> = Settings[K];

/** Whether the skill that teaches `grok` to write graph files is in place. */
export interface SkillStatus {
  path: string;
  installed: boolean;
  /** False when an older GrokSpace installed a different version of the skill. */
  current: boolean;
}

/** Grid presets, named columns-by-rows. Freeform splits are a later phase. */
export type PaneLayout = (typeof PANE_LAYOUTS)[number];

export function paneCount(layout: PaneLayout): number {
  const [cols, rows] = layout.split("x").map(Number);
  return (cols ?? 1) * (rows ?? 1);
}

export type MemoryEntryType = (typeof MEMORY_ENTRY_TYPES)[number];

export interface MemoryEntry {
  projectId: string;
  key: string;
  content: string;
  type: MemoryEntryType;
  updatedAt: number;
}
