import { invoke, type Channel } from "@tauri-apps/api/core";

import type { PlaybookRecord } from "./playbook";
import type { UserSkillRecord } from "./skillProvenance";
import type {
  DiffState,
  EdgesSnapshot,
  FolderTrust,
  FolderTrustDecision,
  GraphSnapshot,
  MemoryEntry,
  MemoryEntryType,
  MergeOutcome,
  PermissionLedgerEntry,
  PermissionPolicy,
  PermissionPolicyRule,
  Project,
  ProjectSettings,
  Session,
  SessionKind,
  SessionSteps,
  Settings,
  SkillStatus,
  StepStatus,
  Task,
  TaskStatus,
  WorktreeGcEntry,
} from "../types";

/**
 * Typed wrappers around the Tauri commands, so components never spell out raw
 * command names or argument shapes.
 */

/** Session id → unix-ms. Nested `Record<>` in `invoke<>` hides the command name from the IPC test. */
type InboxSnoozeUntil = { [sessionId: string]: number };

/**
 * Three-state description for `update_task`.
 *
 * `undefined` becomes JSON `null` and leaves the column. `""` is the clear
 * sentinel and must stay `""` — `||` would collapse it to `null` and the
 * backend would keep the old value.
 */
export function taskDescriptionPatch(description: string | undefined): string | null {
  return description === undefined ? null : description;
}

export const api = {
  listProjects: (): Promise<Project[]> => invoke<Project[]>("list_projects"),

  /** Native picker only — the webview cannot supply a path. Cancel is `null`. */
  openProject: (): Promise<Project | null> => invoke<Project | null>("open_project"),

  updateProject: (
    id: string,
    changes: { name?: string; settings?: ProjectSettings },
  ): Promise<Project> =>
    invoke<Project>("update_project", {
      id,
      name: changes.name ?? null,
      settings: changes.settings ?? null,
    }),

  touchProject: (id: string): Promise<Project> => invoke<Project>("touch_project", { id }),

  /** Forgets the project. Nothing on disk is deleted. Folder trust stays. */
  removeProject: (id: string): Promise<void> => invoke<void>("remove_project", { id }),

  projectTrust: (id: string): Promise<FolderTrust> => invoke<FolderTrust>("project_trust", { id }),

  /** Deny / Trust once / Trust this folder. Only `folder` is written to ~/.grokspace. */
  setProjectTrust: (id: string, decision: FolderTrustDecision): Promise<FolderTrust> =>
    invoke<FolderTrust>("set_project_trust", { id, decision }),

  listSessions: (projectId: string): Promise<Session[]> =>
    invoke<Session[]>("list_sessions", { projectId }),

  /**
   * Starts a session. `paneId` is absent for an `agent`, which runs beside the grid
   * rather than in it, and `role` for one nobody started as anything in particular.
   *
   * Sent as one nested value because the backend takes it as one: the argument list
   * had grown past what a reader can follow. `allowUnisolated` is omitted unless
   * the caller confirmed — the happy path must not send the flag.
   */
  createSession: (input: {
    projectId: string;
    paneId: string | null;
    kind: SessionKind;
    role?: string;
    cols: number;
    rows: number;
    /** Confirm starting an agent on the project tree when isolation skipped. */
    allowUnisolated?: boolean;
  }): Promise<Session> =>
    invoke<Session>("create_session", { session: sessionCreatePayload(input) }),

  /** Routes the session's output into `onOutput`, replaying buffered scrollback. */
  attachSession: (id: string, onOutput: Channel<ArrayBuffer>): Promise<void> =>
    invoke<void>("attach_session", { id, onOutput }),

  writeSession: (id: string, data: string): Promise<void> =>
    invoke<void>("write_session", { id, data }),

  resizeSession: (id: string, cols: number, rows: number): Promise<void> =>
    invoke<void>("resize_session", { id, cols, rows }),

  stopSession: (id: string): Promise<void> => invoke<void>("stop_session", { id }),

  /** Starts a replacement session in the same pane and returns it. */
  restartSession: (id: string, cols: number, rows: number): Promise<Session> =>
    invoke<Session>("restart_session", { id, cols, rows }),

  renameSession: (id: string, title: string): Promise<Session> =>
    invoke<Session>("rename_session", { id, title }),

  /** Ends the session and frees its pane. */
  closeSession: (id: string): Promise<void> => invoke<void>("close_session", { id }),

  /**
   * Force-removes a stopped session's git worktree. Close refuses while the tree
   * is dirty; this is the way to throw that work away on purpose.
   */
  discardSessionWorktree: (id: string): Promise<Session> =>
    invoke<Session>("discard_session_worktree", { id }),

  /**
   * Commits leftover files on a stopped session's branch and merges that branch
   * into the project. The worktree is then removed; Discard is the other button.
   */
  mergeSessionWorktree: (id: string): Promise<MergeOutcome> =>
    invoke<MergeOutcome>("merge_session_worktree", { id }),

  /**
   * Why Merge would refuse this session, without writing. `null` means leftover
   * commit + merge may run. Conflicts are not predicted.
   */
  sessionMergeReadiness: (id: string): Promise<string | null> =>
    invoke<string | null>("session_merge_readiness", { id }),

  /**
   * Leftover worktrees with no session row, plus sizes. Dirty trees are listed
   * so Settings can show them; they are not removable.
   */
  previewWorktreeGc: (projectId: string): Promise<WorktreeGcEntry[]> =>
    invoke<WorktreeGcEntry[]>("preview_worktree_gc", { projectId }),

  /**
   * Removes clean orphan worktrees after Settings confirm. Dirty trees stay.
   * Returns what is still leftover.
   */
  gcOrphanWorktrees: (projectId: string): Promise<WorktreeGcEntry[]> =>
    invoke<WorktreeGcEntry[]>("gc_orphan_worktrees", { projectId }),

  /**
   * Sends a prompt to an `agent` session. `writeSession` is the terminal
   * equivalent and cannot know whether anything read what it typed; this is a
   * request, and the agent's reply is what returns the session to `idle`.
   */
  promptSession: (id: string, text: string): Promise<void> =>
    invoke<void>("prompt_session", { id, text }),

  /** Interrupts the current turn of an `agent` without ending the session. */
  cancelSession: (id: string): Promise<void> => invoke<void>("cancel_session", { id }),

  /** Answers what an agent is blocked on, which is what lets it carry on. */
  answerSessionPermission: (
    id: string,
    requestId: number,
    allow: boolean,
    optionId?: string,
  ): Promise<void> =>
    invoke<void>("answer_session_permission", {
      id,
      requestId,
      allow,
      optionId: optionId ?? null,
    }),

  listTasks: (projectId: string): Promise<Task[]> => invoke<Task[]>("list_tasks", { projectId }),

  /** Adds a task to the project's backlog. */
  createTask: (input: {
    projectId: string;
    title: string;
    description?: string;
  }): Promise<Task> =>
    invoke<Task>("create_task", {
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? null,
    }),

  /**
   * Patch a task. `description` is three-state over IPC: omit it (this helper
   * sends `null`) to leave the column; pass `""` as the clear sentinel to write
   * SQL NULL; any other string replaces the stored value.
   */
  updateTask: (
    id: string,
    changes: {
      title?: string;
      /** Empty string clears the description. Omit the field to leave it. */
      description?: string;
      status?: TaskStatus;
      priority?: number;
    },
  ): Promise<Task> =>
    invoke<Task>("update_task", {
      id,
      title: changes.title ?? null,
      description: taskDescriptionPatch(changes.description),
      status: changes.status ?? null,
      priority: changes.priority ?? null,
    }),

  /** Hands the task to a session and moves it to `in_progress` together. */
  dispatchTask: (id: string, sessionId: string) =>
    invoke<Task>("dispatch_task", { id, sessionId }),

  /** Undoes a dispatch: no session, back in the backlog. */
  undispatchTask: (id: string): Promise<Task> => invoke<Task>("undispatch_task", { id }),

  removeTask: (id: string): Promise<void> => invoke<void>("remove_task", { id }),

  /**
   * What the agents have changed, according to git. `sessionId` scopes the
   * reading to that agent's worktree; omit it for the project's own tree.
   */
  projectDiff: (projectId: string, sessionId?: string | null): Promise<DiffState> =>
    invoke<DiffState>("project_diff", { projectId, sessionId: sessionId ?? null }),

  /**
   * One file's diff. `untracked` picks the comparison: a file git has never seen has
   * nothing in HEAD to diff against, so it is diffed against nothing and reads as all
   * additions. `sessionId` is the same scope as `projectDiff`.
   */
  fileDiff: (
    projectId: string,
    path: string,
    untracked: boolean,
    sessionId?: string | null,
  ): Promise<string> =>
    invoke<string>("file_diff", {
      projectId,
      path,
      untracked,
      sessionId: sessionId ?? null,
    }),

  /**
   * Reveal a file in the OS file manager (Finder on macOS). The path is
   * confined to the project or the session's worktree — this is not the
   * Tauri shell-open plugin.
   */
  revealArtifact: (
    projectId: string,
    path: string,
    sessionId?: string | null,
  ): Promise<void> =>
    invoke<void>("reveal_artifact", {
      projectId,
      path,
      sessionId: sessionId ?? null,
    }),

  readSettings: (): Promise<Settings> => invoke<Settings>("read_settings"),

  /** Writes one preference and returns them all, since the backend fills defaults. */
  writeSetting: <K extends keyof Settings>(
    key: K,
    value: Settings[K],
  ): Promise<Settings> => invoke<Settings>("write_setting", { key, value }),

  /** User-authored globs in `~/.grokspace/permission-policy.json`. */
  readPermissionPolicy: (): Promise<PermissionPolicy> =>
    invoke<PermissionPolicy>("read_permission_policy"),

  writePermissionPolicy: (rules: PermissionPolicyRule[]): Promise<PermissionPolicy> =>
    invoke<PermissionPolicy>("write_permission_policy", { rules }),

  /** Inbox snooze-until map in `~/.grokspace/inbox-snooze.json`. Never answers ACP. */
  readInboxSnooze: (): Promise<InboxSnoozeUntil> => invoke<InboxSnoozeUntil>("read_inbox_snooze"),

  writeInboxSnooze: (until: InboxSnoozeUntil): Promise<InboxSnoozeUntil> =>
    invoke<InboxSnoozeUntil>("write_inbox_snooze", { until }),

  /**
   * Last N permission answers for this project (`~/.grokspace/ledgers/<id>.jsonl`).
   * Local file only; the host does not send this anywhere.
   */
  listPermissionLedger: (
    projectId: string,
    limit?: number,
  ): Promise<PermissionLedgerEntry[]> =>
    invoke<PermissionLedgerEntry[]>("list_permission_ledger", {
      projectId,
      limit: limit ?? null,
    }),

  /** Writes `~/.grokspace/playbooks/<name>/` (graph, steps, roles, memory excerpt). */
  savePlaybook: (input: {
    name: string;
    roles: string[];
    graph: string;
    steps: string;
    memory: string;
  }): Promise<PlaybookRecord> => invoke<PlaybookRecord>("save_playbook", input),

  readPlaybook: (name: string, projectId: string | null): Promise<PlaybookRecord> =>
    invoke<PlaybookRecord>("read_playbook", { name, projectId }),

  listMemory: (projectId: string): Promise<MemoryEntry[]> =>
    invoke<MemoryEntry[]>("list_memory", { projectId }),

  /**
   * Writes one entry and returns the whole memory, since the file agents read is
   * rebuilt from all of it and the panel wants the list it was built from.
   *
   * `type` is `entryType` across the boundary because `type` is a Rust keyword; the
   * entry itself still carries it as `type`.
   */
  putMemory: (
    projectId: string,
    entry: { key: string; content: string; type: MemoryEntryType },
  ): Promise<MemoryEntry[]> =>
    invoke<MemoryEntry[]>("put_memory", {
      projectId,
      key: entry.key,
      content: entry.content,
      entryType: entry.type,
    }),

  removeMemory: (projectId: string, key: string): Promise<MemoryEntry[]> =>
    invoke<MemoryEntry[]>("remove_memory", { projectId, key }),

  /** The file the project's agents are told to read, for the panel to name. */
  memoryFilePath: (projectId: string): Promise<string> =>
    invoke<string>("memory_file_path", { projectId }),

  skillStatus: (id: string): Promise<SkillStatus> => invoke<SkillStatus>("skill_status", { id }),

  /** Installs, or refreshes, a bundled skill so `grok` can see it. */
  installSkill: (id: string): Promise<SkillStatus> => invoke<SkillStatus>("install_skill", { id }),

  /**
   * Writes `~/.grokspace/skills/<name>/SKILL.md`. Does not copy into
   * `~/.grok/skills/` — grok will not see it until someone copies it there.
   */
  saveUserSkill: (input: { name: string; markdown: string }): Promise<UserSkillRecord> =>
    invoke<UserSkillRecord>("save_user_skill", input),

  /**
   * Writes a handoff folder for one session. The destination is a native folder
   * picker — the webview cannot supply a path. Cancel is `null`.
   */
  exportSessionPack: (sessionId: string, transcript: string): Promise<string | null> =>
    invoke<string | null>("export_session_pack", { sessionId, transcript }),

  /** Reads the graph file belonging to one session, whether or not it exists. */
  readSessionGraph: (sessionId: string): Promise<GraphSnapshot> =>
    invoke<GraphSnapshot>("read_session_graph", { sessionId }),

  /** Every session's graph in the project, including sessions with no file yet. */
  listSessionGraphs: (projectId: string): Promise<GraphSnapshot[]> =>
    invoke<GraphSnapshot[]>("list_session_graphs", { projectId }),

  /**
   * Watches the directory the project's sessions write their graphs into so changes
   * are reported, and returns what is being watched. Asking twice is harmless.
   */
  watchProjectGraphs: (projectId: string): Promise<string[]> =>
    invoke<string[]>("watch_project_graphs", { projectId }),

  /** Project `.grokspace/edges.json`, whether or not it exists. */
  readProjectEdges: (projectId: string): Promise<EdgesSnapshot> =>
    invoke<EdgesSnapshot>("read_project_edges", { projectId }),

  listSessionSteps: (sessionId: string): Promise<SessionSteps> =>
    invoke<SessionSteps>("list_session_steps", { sessionId }),

  listProjectSteps: (projectId: string): Promise<SessionSteps[]> =>
    invoke<SessionSteps[]>("list_project_steps", { projectId }),

  addSessionStep: (sessionId: string, title: string): Promise<SessionSteps> =>
    invoke<SessionSteps>("add_session_step", { sessionId, title }),

  updateSessionStep: (
    id: string,
    changes: { title?: string; status?: StepStatus },
  ): Promise<SessionSteps> =>
    invoke<SessionSteps>("update_session_step", {
      id,
      title: changes.title ?? null,
      status: changes.status ?? null,
    }),

  removeSessionStep: (id: string): Promise<SessionSteps> =>
    invoke<SessionSteps>("remove_session_step", { id }),

  reorderSessionSteps: (sessionId: string, ids: string[]): Promise<SessionSteps> =>
    invoke<SessionSteps>("reorder_session_steps", { sessionId, ids }),

  approveSessionSteps: (sessionId: string): Promise<SessionSteps> =>
    invoke<SessionSteps>("approve_session_steps", { sessionId }),

  /** Puts an approved list back to `proposed` when the follow-up prompt failed. */
  reopenSessionSteps: (sessionId: string): Promise<SessionSteps> =>
    invoke<SessionSteps>("reopen_session_steps", { sessionId }),

  /**
   * Watches the directory the project's sessions write their step lists into so
   * changes are reported. Asking twice is harmless.
   */
  watchProjectSteps: (projectId: string): Promise<string[]> =>
    invoke<string[]>("watch_project_steps", { projectId }),

  /**
   * Appends a renderer line to `~/.grokspace/logs/grokspace.log`.
   * Local file only; the host does not send this anywhere.
   */
  logClientError: (source: string, message: string): Promise<void> =>
    invoke<void>("log_client_error", { source, message }),

};

/** `create_session` body. `allowUnisolated` is omitted unless it is true. */
export function sessionCreatePayload(input: {
  projectId: string;
  paneId: string | null;
  kind: SessionKind;
  role?: string;
  cols: number;
  rows: number;
  allowUnisolated?: boolean;
}) {
  const session = {
    projectId: input.projectId,
    paneId: input.paneId,
    kind: input.kind,
    role: input.role ?? null,
    cols: input.cols,
    rows: input.rows,
  };
  return input.allowUnisolated === true ? { ...session, allowUnisolated: true as const } : session;
}

/** Rust returns errors as plain strings, so unwrap them for display. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
