import { useMemo } from "react";
import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import {
  DEFAULT_DOOM_LOOP_THRESHOLD,
  doomLoopTripped,
  noteToolRepeat,
  type ToolRepeat,
} from "../lib/doomLoop";
import { unlockGraphTitles } from "../lib/graph";
import { FALLBACK_PTY_SIZE } from "../lib/limits";
import {
  grantSessionLease,
  leaseCanAutoAnswer,
  proposedLease,
} from "../lib/permissionLease";
import { batonPrompt, briefPrompt, sourceGraphFile, type Role } from "../lib/roles";
import { talkToSession, transcriptExcerpt } from "../lib/talkToSession";
import { foldUpdate } from "../lib/transcript";
import type {
  AgentUpdate,
  PermissionRequest,
  Session,
  SessionKind,
  SessionStatus,
  StepsPhase,
} from "../types";
import { useGraphStore } from "./graphStore";
import { useStepStore } from "./stepStore";
import { useUiStore } from "./uiStore";

function releaseTerminal(sessionId: string): void {
  // Dynamic so opening an empty workspace does not download xterm (COMPILE-001).
  void import("../lib/terminals").then((terminals) => {
    terminals.disposeTerminal(sessionId);
  });
}

/**
 * A pane holds at most one session, so starting in a pane displaces the old one.
 *
 * An agent has no pane, and two of them must not displace each other, which is why
 * a null `paneId` is never treated as a match.
 */
function replaceInPane(sessions: Session[], next: Session): Session[] {
  return [
    ...sessions.filter(
      (session) =>
        session.id !== next.id && (next.paneId === null || session.paneId !== next.paneId),
    ),
    next,
  ];
}

function permissionsFrom(sessions: Session[]): Record<string, PermissionRequest[]> {
  const permissions: Record<string, PermissionRequest[]> = {};
  for (const session of sessions) {
    const pending = session.pendingPermissions;
    if (pending !== undefined && pending.length > 0) {
      permissions[session.id] = pending;
    }
  }
  return permissions;
}

/** Drops in-flight `loadSessions` results that a newer project switch has replaced. */
let loadGeneration = 0;

/**
 * Drops in-flight `inspectMerge` results that a newer inspect or merge replaced,
 * so a late "ready" cannot hide a conflict abort that already landed on the strip.
 */
const inspectGeneration: Record<string, number> = {};

function bumpInspect(id: string): number {
  const next = (inspectGeneration[id] ?? 0) + 1;
  inspectGeneration[id] = next;
  return next;
}

/** Cancels an in-flight inspect and drops the generation key so the map cannot grow. */
function forgetInspect(id: string): void {
  bumpInspect(id);
  delete inspectGeneration[id];
}

function liveSessionIds(sessions: readonly Session[]): Set<string> {
  return new Set(sessions.filter(isLiveAgent).map((session) => session.id));
}

/** Overlap worktree add + spawn; keep per-role error isolation. */
const SWARM_CONCURRENCY = 3;

/** Rust fail-closed. The banner uses a different sentence and must not match. */
export function isIsolationConfirmError(message: string): boolean {
  return (
    message.includes("isolation did not happen") &&
    message.includes("confirm to start on the project tree")
  );
}

/** Concurrent swarm roles share one dialog. The answer does not outlive this start. */
let isolationGate: {
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
} | null = null;

function askIsolationConfirm(
  set: (partial: { isolationConfirm: { message: string } | null }) => void,
  message: string,
): Promise<boolean> {
  if (isolationGate !== null) return isolationGate.promise;
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  isolationGate = { promise, resolve };
  set({ isolationConfirm: { message } });
  return promise;
}

function settleIsolationConfirm(
  set: (partial: { isolationConfirm: { message: string } | null }) => void,
  ok: boolean,
): void {
  const gate = isolationGate;
  isolationGate = null;
  set({ isolationConfirm: null });
  gate?.resolve(ok);
}

async function mapPool<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await run(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, () => worker()),
  );
}

interface StartInput {
  projectId: string;
  /** Absent for an agent, which runs beside the grid rather than in it. */
  paneId: string | null;
  kind: SessionKind;
  /** What it is being started as, when it is being started as anything. */
  role?: string;
  cols: number;
  rows: number;
  /** Confirm starting an agent on the project tree when isolation skipped. */
  allowUnisolated?: boolean;
}

/**
 * An ACP agent that never got a worktree is on the project tree. The sentence is
 * what the banner says when the live skip reason has not arrived, or after a
 * reload that only has `kind` and a null path.
 *
 * Stopped sessions are excluded: Merge and Discard clear `worktreePath` on a
 * session that *did* isolate, and a stopped agent is no longer writing anywhere.
 */
export const UNISOLATED_REASON =
  "Isolation did not happen, so this agent is on the project tree.";

function isLiveAgent(session: Session): boolean {
  return (
    session.status === "running" ||
    session.status === "idle" ||
    session.status === "needs_input"
  );
}

export function isUnisolatedAgent(session: Session): boolean {
  return session.kind === "agent" && session.worktreePath === null && isLiveAgent(session);
}

/** The banner line for one unisolated agent. `reason` is the skip, when we have it. */
export function isolationNotice(session: Session, reason?: string): string {
  const title = session.title?.trim() || "Agent";
  const why = reason !== undefined && reason !== "" && reason !== UNISOLATED_REASON ? reason : null;
  if (why === null) {
    return `${title} is not isolated. ${UNISOLATED_REASON}`;
  }
  return `${title} is not isolated. Isolation did not happen (${why}), so this agent is on the project tree.`;
}

function isolationFrom(
  sessions: Session[],
  previous: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const session of sessions) {
    if (isUnisolatedAgent(session)) {
      const stored = session.isolationSkip?.trim();
      next[session.id] = previous[session.id] ?? (stored ? stored : UNISOLATED_REASON);
    }
  }
  return next;
}

/**
 * Host permission mode on agent chrome. `plan` is Spec. `ask` is today's
 * chips. `acceptEdits` auto-grants FEAT-005 edit-class leases, still
 * `allow_once` to ACP. Never `yolo` / `bypassPermissions`. Never sent on
 * `session/new` or `grok agent --permission-mode`.
 */
export const PERMISSION_MODES = ["plan", "ask", "acceptEdits"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Mutating file tools. Read is a file tool but not an edit. Bash is out. */
const EDIT_CLASS_TOOLS = new Set(["edit", "write", "delete", "move", "create"]);

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Chip value. Spec (`proposed`) is plan until the user picks another mode.
 */
export function permissionModeFor(
  phase: StepsPhase | undefined,
  stored: PermissionMode | undefined,
): PermissionMode {
  if (stored !== undefined) return stored;
  return phase === "proposed" ? "plan" : "ask";
}

function editClassLease(summary: string) {
  const offer = proposedLease(summary);
  if (offer === null) return null;
  if (!EDIT_CLASS_TOOLS.has(offer.tool.toLowerCase())) return null;
  return offer;
}

interface SessionState {
  sessions: Session[];
  /** Panes with a start or restart in flight, so the UI can show progress. */
  busyPanes: Record<string, boolean>;
  /**
   * What each agent is blocked on, keyed by session. Only ACP sessions ever have
   * any: a terminal has no way to ask.
   */
  permissions: Record<string, PermissionRequest[]>;
  /**
   * Visible ACP output, keyed by session. Survives a project switch so coming
   * back does not blank a conversation that is still running.
   */
  transcript: Record<string, AgentUpdate[]>;
  /** Consecutive identical tool texts, keyed by session. */
  toolRepeats: Record<string, ToolRepeat>;
  /**
   * Host Pause / Continue prompts after N identical tools. Not an ACP
   * permission — Pause cancels the turn; Continue dismisses and resets.
   */
  doomLoops: Record<string, ToolRepeat>;
  /**
   * Why isolation failed, keyed by session. Live events fill the skip reason;
   * reload prefers `session.isolationSkip`, then the generic sentence.
   */
  isolationReasons: Record<string, string>;
  /** Open isolation confirm. Null when nobody is waiting. */
  isolationConfirm: { message: string } | null;
  isLoading: boolean;
  error: string | null;
  /**
   * Why Merge would refuse each session, keyed by id. `null` means the
   * pre-checks passed; absent means not yet inspected. A conflict abort is
   * written here after click — it cannot be known before `git merge` runs.
   */
  mergeReasons: Record<string, string | null>;
  /**
   * Host permission mode per session. Absent means derive from steps: Spec
   * (`proposed`) is plan, otherwise ask. Dropped on Stop / Restart / Close.
   */
  permissionModes: Record<string, PermissionMode>;

  loadSessions: (projectId: string) => Promise<void>;
  /** Host-only. Rejects yolo. Does not pass mode into ACP. */
  setPermissionMode: (id: string, mode: PermissionMode) => Promise<void>;
  createSession: (
    input: StartInput,
    options?: {
      /**
       * A later swarm role must not wipe the banner that named an earlier
       * failure. Palette and the board both read this field.
       */
      keepError?: boolean;
      /** Swarm confirms once; single starts use the store dialog. */
      confirmUnisolated?: (message: string) => Promise<boolean>;
    },
  ) => Promise<Session | null>;
  /** @deprecated Use `createSession`. Alias for one release. */
  startSession: (
    input: StartInput,
    options?: {
      keepError?: boolean;
      confirmUnisolated?: (message: string) => Promise<boolean>;
    },
  ) => Promise<Session | null>;
  confirmUnisolatedStart: () => void;
  cancelUnisolatedStart: () => void;
  /**
   * Starts one agent per role and tells each what it is for. Returns the roles that
   * would not start, so the caller can say which rather than only that some did.
   */
  launchSwarm: (projectId: string, roles: readonly Role[]) => Promise<string[]>;
  /**
   * Hands the source's locked plan to Coder or Reviewer. Cancels an in-flight
   * prompt on the source (idle, not Close). Prompts an idle peer, or starts one.
   * Briefing failure closes only the new session, like a swarm role that never
   * got its brief.
   */
  handToRole: (sourceId: string, role: Role, projectPath: string) => Promise<boolean>;
  stopSession: (id: string) => Promise<void>;
  restartSession: (id: string, cols: number, rows: number) => Promise<Session | null>;
  renameSession: (id: string, title: string) => Promise<void>;
  closeSession: (id: string) => Promise<void>;
  /**
   * Force-removes a stopped agent's worktree so Close can proceed. A live
   * agent is refused: throwing away its cwd while it is writing is worse than
   * a stuck Close button.
   */
  discardWorktree: (id: string) => Promise<void>;
  /**
   * Commits leftover files on a stopped agent's branch and merges that branch
   * into the project. The tree is then removed, same as a successful Discard.
   * A non-null readiness reason is written onto the merge strip and merge is
   * not invoked — palette and Diff share this path.
   */
  mergeWorktree: (id: string) => Promise<void>;
  /**
   * Reads why Merge would refuse this session, without writing. The Diff
   * panel calls this when a stopped worktree is scoped.
   */
  inspectMerge: (id: string) => Promise<void>;
  markExited: (id: string, exitCode: number | null) => void;
  /** From the backend's status event, which only agents emit. */
  markStatus: (id: string, status: SessionStatus) => void;
  /** From the backend's permission event. */
  askPermission: (id: string, request: PermissionRequest) => void;
  answerPermission: (
    id: string,
    requestId: number,
    allow: boolean,
    optionId?: string,
  ) => Promise<void>;
  /** From the backend's `session-isolation` event. */
  noteIsolation: (id: string, reason: string) => void;
  /** From the backend's `session-update` event. */
  appendUpdate: (id: string, update: AgentUpdate) => void;
  /** Sends a follow-up to an idle agent. */
  promptSession: (id: string, text: string) => Promise<void>;
  /** Interrupts the current turn without ending the session. */
  cancelSession: (id: string) => Promise<void>;
  /** Pause on a doom-loop prompt: cancel the turn. */
  pauseDoomLoop: (id: string) => Promise<void>;
  /** Continue on a doom-loop prompt: dismiss and reset the streak. */
  continueDoomLoop: (id: string) => void;
  setError: (error: string) => void;
  /**
   * Drops graphs, steps, and transcript for these ids. When `clearWorkspace`
   * the session list and pane chrome go too — used when the active project
   * is forgotten.
   */
  forgetSessions: (ids: readonly string[], clearWorkspace: boolean) => void;
  clearError: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  busyPanes: {},
  permissions: {},
  transcript: {},
  toolRepeats: {},
  doomLoops: {},
  isolationReasons: {},
  isolationConfirm: null,
  isLoading: false,
  error: null,
  mergeReasons: {},
  permissionModes: {},

  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  confirmUnisolatedStart: () => settleIsolationConfirm(set, true),
  cancelUnisolatedStart: () => settleIsolationConfirm(set, false),

  setPermissionMode: async (id, mode) => {
    if (!isPermissionMode(mode)) return;
    if (!get().sessions.some((session) => session.id === id)) return;
    set((state) => ({
      permissionModes: { ...state.permissionModes, [id]: mode },
    }));
    if (mode !== "plan") return;
    const phase = useStepStore.getState().bySession[id]?.phase;
    if (phase !== "approved") return;
    await useStepStore.getState().reopen(id);
    unlockGraphTitles(id);
  },

  forgetSessions: (ids, clearWorkspace) => {
    for (const id of ids) forgetSessionFiles(id);
    const forgotten = new Set(ids);
    set((state) => ({
      transcript: Object.fromEntries(
        Object.entries(state.transcript).filter(([sessionId]) => !forgotten.has(sessionId)),
      ),
      toolRepeats: Object.fromEntries(
        Object.entries(state.toolRepeats).filter(([sessionId]) => !forgotten.has(sessionId)),
      ),
      doomLoops: Object.fromEntries(
        Object.entries(state.doomLoops).filter(([sessionId]) => !forgotten.has(sessionId)),
      ),
      permissionModes: Object.fromEntries(
        Object.entries(state.permissionModes).filter(([sessionId]) => !forgotten.has(sessionId)),
      ),
      ...(clearWorkspace ? { sessions: [], permissions: {}, permissionModes: {} } : {}),
    }));
    if (clearWorkspace) {
      useUiStore.getState().resetPaneChrome();
    }
  },

  loadSessions: async (projectId) => {
    const generation = ++loadGeneration;
    const leaving = get().sessions;
    // Pane ids are reused across projects. Until this fetch returns, the grid
    // would keep drawing the previous project's terminals — including a Grok TUI
    // that then sits on the wrong folder. Drop them now; a same-project reload
    // must not, or overlapping graphs and live xterms go blank.
    const switching = leaving.some((session) => session.projectId !== projectId);
    useUiStore.getState().resetPaneChrome();
    set({
      isLoading: true,
      error: null,
      ...(switching
        ? {
            sessions: [],
            permissions: {},
            permissionModes: {},
            busyPanes: {},
            mergeReasons: {},
            isolationReasons: {},
          }
        : {}),
    });
    if (switching) {
      for (const session of leaving) {
        // attach() already replays pty scrollback; keeping xterm (10k lines)
        // across projects is optional cache, not correctness.
        releaseTerminal(session.id);
        forgetSessionFiles(session.id);
        forgetInspect(session.id);
      }
    }
    try {
      const sessions = await api.listSessions(projectId);
      if (generation !== loadGeneration) return;
      // Graphs of sessions that are not in the arriving list belong to a project
      // being left; nothing will ask for them again, and the watcher that fed them
      // is still running. Sessions that survive the load keep the graph they had,
      // so re-reading the same project does not blank the panel.
      const arriving = new Set(sessions.map((session) => session.id));
      for (const departing of get().sessions) {
        if (!arriving.has(departing.id)) forgetSessionFiles(departing.id);
      }
      set((state) => ({
        sessions,
        permissions: permissionsFrom(sessions),
        isLoading: false,
        isolationReasons: isolationFrom(sessions, state.isolationReasons),
        // Live conversations survive a project switch so coming back is not blank.
        // Stopped ones do not: those strings plus xterm instances were unbounded.
        transcript: keepOnly(
          state.transcript,
          new Set([...arriving, ...liveSessionIds(switching ? leaving : [])]),
        ),
        toolRepeats: keepOnly(
          state.toolRepeats,
          new Set([...arriving, ...liveSessionIds(switching ? leaving : [])]),
        ),
        doomLoops: keepOnly(
          state.doomLoops,
          new Set([...arriving, ...liveSessionIds(switching ? leaving : [])]),
        ),
        mergeReasons: keepOnly(state.mergeReasons, arriving),
        permissionModes: keepOnly(state.permissionModes, arriving),
      }));
    } catch (error) {
      if (generation !== loadGeneration) return;
      for (const departing of get().sessions) {
        forgetSessionFiles(departing.id);
      }
      set({
        error: errorMessage(error),
        isLoading: false,
        sessions: [],
        permissions: {},
        permissionModes: {},
        mergeReasons: {},
      });
    }
  },

  createSession: async (input, options) => {
    // An agent has no pane, so there is no pane to mark busy or to switch back to
    // its terminal. Keying either on `null` would invent a pane called "null".
    const paneId = input.paneId;
    const busy = (value: boolean) =>
      paneId === null ? {} : { busyPanes: { ...get().busyPanes, [paneId]: value } };

    set((state) => ({
      ...busy(true),
      error: options?.keepError ? state.error : null,
      permissions: state.permissions,
    }));
    try {
      const { allowUnisolated, ...rest } = input;
      const session = await api.createSession(
        allowUnisolated === true ? { ...rest, allowUnisolated: true } : rest,
      );
      if (paneId !== null) {
        // A pane left showing the previous session's graph should greet a new
        // session with its terminal, which is the thing that needs watching.
        useUiStore.getState().setPaneView(paneId, "terminal");
      }
      set((state) => {
        const sessions = replaceInPane(state.sessions, session);
        return {
          sessions,
          isolationReasons: isolationFrom(sessions, state.isolationReasons),
        };
      });
      return session;
    } catch (error) {
      const message = errorMessage(error);
      if (input.allowUnisolated !== true && isIsolationConfirmError(message)) {
        // Dialog, not the raw fail-closed sentence on the banner.
        const ask =
          options?.confirmUnisolated ?? ((text) => askIsolationConfirm(set, text));
        const confirmed = await ask(message);
        if (confirmed) {
          return get().createSession({ ...input, allowUnisolated: true }, options);
        }
        return null;
      }
      set({ error: message });
      return null;
    } finally {
      set(() => busy(false));
    }
  },

  startSession: (input, options) => get().createSession(input, options),

  launchSwarm: async (projectId, roles) => {
    const failed: string[] = [];
    const reasons: string[] = [];
    // One confirm for this launch. A later New agent still asks.
    let unisolated: boolean | undefined;
    const confirmUnisolated = async (message: string) => {
      if (unisolated === undefined) {
        unisolated = await askIsolationConfirm(set, message);
      }
      return unisolated;
    };
    // One role's failure does not stop the rest: five roles are five
    // independent sessions. Starts overlap (bounded) so five `git worktree add`
    // calls are not strictly serial. Prompting follows each spawn; it does not
    // wait for another role's brief to finish.
    await mapPool(roles, SWARM_CONCURRENCY, async (role) => {
      const session = await get().createSession(
        {
          projectId,
          paneId: null,
          kind: "agent",
          role: role.name,
          ...FALLBACK_PTY_SIZE,
        },
        { keepError: true, confirmUnisolated },
      );
      if (session === null) {
        failed.push(role.name);
        const err = get().error;
        if (err !== null) {
          reasons.push(`${role.name}: ${err}`);
        } else if (unisolated !== false) {
          reasons.push(`${role.name}: could not start`);
        }
        return;
      }

      try {
        await api.promptSession(session.id, briefPrompt(role));
      } catch (error) {
        // Started but never briefed, which is worse than not started: it would sit
        // there looking ready while knowing nothing about its job. Close it so a
        // retry can create the role again instead of seeing it already in play.
        const reason = errorMessage(error);
        await get().closeSession(session.id);
        failed.push(role.name);
        reasons.push(`${role.name}: ${reason}`);
      }
    });
    if (reasons.length > 0) {
      set({ error: reasons.join(" · ") });
    }
    return failed;
  },

  handToRole: async (sourceId, role, projectPath) => {
    const source = get().sessions.find((session) => session.id === sourceId);
    if (source === undefined || source.status === "stopped") {
      set({ error: "That session is not running." });
      return false;
    }
    if (source.status === "running") {
      set({ error: null });
      await get().cancelSession(sourceId);
      if (get().error !== null) return false;
    }

    const storedPath = useGraphStore.getState().bySession[sourceId]?.path;
    const steps = useStepStore.getState().bySession[sourceId];
    const approvedTitles =
      steps?.phase === "approved" ? steps.steps.map((step) => step.title) : [];
    const prompt = batonPrompt({
      role,
      sourceGraphPath: sourceGraphFile(sourceId, projectPath, storedPath),
      approvedTitles,
      excerpt: transcriptExcerpt(get().transcript[sourceId] ?? []),
    });

    const idle = get().sessions.find(
      (session) =>
        session.id !== sourceId &&
        session.projectId === source.projectId &&
        session.kind === "agent" &&
        session.role === role.name &&
        session.status === "idle",
    );
    if (idle !== undefined) {
      try {
        await talkToSession(idle, prompt);
        return true;
      } catch (error) {
        set({ error: `${role.name}: ${errorMessage(error)}` });
        return false;
      }
    }

    const created = await get().createSession({
      projectId: source.projectId,
      paneId: null,
      kind: "agent",
      role: role.name,
      ...FALLBACK_PTY_SIZE,
    });
    if (created === null) return false;
    try {
      await talkToSession(created, prompt);
      return true;
    } catch (error) {
      const reason = errorMessage(error);
      await get().closeSession(created.id);
      set({ error: `${role.name}: ${reason}` });
      return false;
    }
  },

  stopSession: async (id) => {
    try {
      // The status change arrives through the exit event, not from here.
      await api.stopSession(id);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  restartSession: async (id, cols, rows) => {
    const paneId = get().sessions.find((session) => session.id === id)?.paneId ?? id;
    set((state) => ({ busyPanes: { ...state.busyPanes, [paneId]: true }, error: null }));
    try {
      const session = await api.restartSession(id, cols, rows);
      // Restarting mints a new session id, so the old terminal has nothing left
      // to attach to and the graph of the run it replaced is not its own.
      releaseTerminal(id);
      forgetSessionFiles(id);
      forgetInspect(id);
      set((state) => {
        const sessions = replaceInPane(
          state.sessions.filter((existing) => existing.id !== id),
          session,
        );
        return {
          sessions,
          isolationReasons: isolationFrom(sessions, without(state.isolationReasons, id)),
          transcript: without(state.transcript, id),
          ...dropDoom(state, id),
          mergeReasons: without(state.mergeReasons, id),
          permissionModes: without(state.permissionModes, id),
        };
      });
      return session;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    } finally {
      set((state) => ({ busyPanes: { ...state.busyPanes, [paneId]: false } }));
    }
  },

  renameSession: async (id, title) => {
    try {
      const session = await api.renameSession(id, title);
      set((state) => ({
        sessions: state.sessions.map((existing) => (existing.id === id ? session : existing)),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  closeSession: async (id) => {
    try {
      await api.closeSession(id);
      releaseTerminal(id);
      forgetSessionFiles(id);
      forgetInspect(id);
      set((state) => ({
        sessions: state.sessions.filter((session) => session.id !== id),
        permissions: without(state.permissions, id),
        transcript: without(state.transcript, id),
        ...dropDoom(state, id),
        isolationReasons: without(state.isolationReasons, id),
        mergeReasons: without(state.mergeReasons, id),
        permissionModes: without(state.permissionModes, id),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  discardWorktree: async (id) => {
    try {
      const session = await api.discardSessionWorktree(id);
      bumpInspect(id);
      set((state) => {
        const sessions = state.sessions.map((existing) =>
          existing.id === id ? session : existing,
        );
        return {
          sessions,
          isolationReasons: isolationFrom(sessions, without(state.isolationReasons, id)),
          error: null,
          mergeReasons: without(state.mergeReasons, id),
        };
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  mergeWorktree: async (id) => {
    try {
      const reason = await api.sessionMergeReadiness(id);
      if (reason != null) {
        bumpInspect(id);
        set((state) => ({
          mergeReasons: { ...state.mergeReasons, [id]: reason },
        }));
        return;
      }
      const { session, teardownError } = await api.mergeSessionWorktree(id);
      bumpInspect(id);
      set((state) => {
        const sessions = state.sessions.map((existing) =>
          existing.id === id ? session : existing,
        );
        return {
          sessions,
          isolationReasons: isolationFrom(sessions, without(state.isolationReasons, id)),
          error: teardownError ?? null,
          mergeReasons: without(state.mergeReasons, id),
        };
      });
    } catch (error) {
      const message = errorMessage(error);
      bumpInspect(id);
      set((state) => ({
        error: message,
        mergeReasons: { ...state.mergeReasons, [id]: message },
      }));
    }
  },

  inspectMerge: async (id) => {
    const generation = bumpInspect(id);
    try {
      const reason = await api.sessionMergeReadiness(id);
      if (inspectGeneration[id] !== generation) return;
      set((state) => ({
        mergeReasons: { ...state.mergeReasons, [id]: reason },
      }));
    } catch (error) {
      if (inspectGeneration[id] !== generation) return;
      set((state) => ({
        mergeReasons: { ...state.mergeReasons, [id]: errorMessage(error) },
      }));
    }
  },

  /**
   * Driven by the backend's exit event. Sessions that were closed rather than
   * stopped are already gone from the list, and their late exit event is a
   * no-op here.
   */
  markExited: (id, exitCode) =>
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === id
          ? { ...session, status: "stopped" as const, exitCode, processId: null }
          : session,
      );
      return {
        sessions,
        isolationReasons: isolationFrom(sessions, state.isolationReasons),
        // Nothing can answer what a session that has gone was asking.
        permissions: without(state.permissions, id),
        ...dropDoom(state, id),
        permissionModes: without(state.permissionModes, id),
      };
    }),

  markStatus: (id, status) =>
    set((state) => {
      // Stopped is terminal. A late handshake Idle after stop/close can
      // otherwise resurrect the chip and offer follow-up on a dead process.
      const existing = state.sessions.find((session) => session.id === id);
      if (existing === undefined) return state;
      if (existing.status === "stopped" && status !== "stopped") return state;
      return {
        sessions: state.sessions.map((session) =>
          session.id === id ? { ...session, status } : session,
        ),
        ...(status === "idle" || status === "stopped" ? dropDoom(state, id) : {}),
        ...(status === "stopped" ? { permissionModes: without(state.permissionModes, id) } : {}),
      };
    }),

  askPermission: (id, request) => {
    const state = get();
    if (!state.sessions.some((session) => session.id === id)) return;
    const mode = permissionModeFor(
      useStepStore.getState().bySession[id]?.phase,
      state.permissionModes[id],
    );
    const offer = mode === "acceptEdits" ? editClassLease(request.summary) : null;
    if (offer !== null && leaseCanAutoAnswer(request)) {
      grantSessionLease(id, offer);
      void (async () => {
        try {
          await api.answerSessionPermission(id, request.requestId, true);
        } catch (error) {
          set((current) => {
            if (!current.sessions.some((session) => session.id === id)) {
              return { error: errorMessage(error) };
            }
            const existing = current.permissions[id] ?? [];
            if (existing.some((item) => item.requestId === request.requestId)) {
              return { error: errorMessage(error) };
            }
            return {
              error: errorMessage(error),
              permissions: {
                ...current.permissions,
                [id]: [...existing, request],
              },
            };
          });
        }
      })();
      return;
    }
    set((current) => {
      const existing = current.permissions[id] ?? [];
      const index = existing.findIndex((item) => item.requestId === request.requestId);
      // Distinct requestIds stay queued — an agent can be blocked on more than
      // one. The same id after loadSessions REPLACE must not stack a second chip.
      const next =
        index === -1
          ? [...existing, request]
          : existing.map((item, i) => (i === index ? request : item));
      return {
        permissions: {
          ...current.permissions,
          [id]: next,
        },
      };
    });
  },

  answerPermission: async (id, requestId, allow, optionId) => {
    try {
      await api.answerSessionPermission(id, requestId, allow, optionId);
      set((state) => ({
        permissions: {
          ...state.permissions,
          [id]: (state.permissions[id] ?? []).filter(
            (request) => request.requestId !== requestId,
          ),
        },
      }));
    } catch (error) {
      // Left in place, so the answer can be tried again. The agent is still
      // waiting either way.
      set({ error: errorMessage(error) });
    }
  },

  noteIsolation: (id, reason) => {
    const trimmed = reason.trim();
    if (trimmed === "") return;
    set((state) => ({
      isolationReasons: { ...state.isolationReasons, [id]: trimmed },
    }));
  },

  appendUpdate: (id, update) =>
    set((state) => {
      const transcript = {
        ...state.transcript,
        [id]: foldUpdate(state.transcript[id] ?? [], update),
      };
      if (update.kind !== "tool") {
        return { transcript };
      }
      const repeat = noteToolRepeat(state.toolRepeats[id], update.text);
      const already = state.doomLoops[id] !== undefined;
      return {
        transcript,
        toolRepeats: { ...state.toolRepeats, [id]: repeat },
        doomLoops:
          !already && doomLoopTripped(repeat, DEFAULT_DOOM_LOOP_THRESHOLD)
            ? { ...state.doomLoops, [id]: repeat }
            : state.doomLoops,
      };
    }),

  promptSession: async (id, text) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    try {
      await api.promptSession(id, trimmed);
      set((state) => dropDoom(state, id));
      get().appendUpdate(id, { kind: "prompt", text: trimmed });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  cancelSession: async (id) => {
    try {
      await api.cancelSession(id);
      set((state) => dropDoom(state, id));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  pauseDoomLoop: (id) => get().cancelSession(id),

  continueDoomLoop: (id) => set((state) => dropDoom(state, id)),
}));

/** Drops the doom-loop streak and host prompt for one session. */
function dropDoom<T extends { toolRepeats: Record<string, ToolRepeat>; doomLoops: Record<string, ToolRepeat> }>(
  state: T,
  id: string,
): Pick<T, "toolRepeats" | "doomLoops"> {
  return {
    toolRepeats: without(state.toolRepeats, id),
    doomLoops: without(state.doomLoops, id),
  };
}

/** A copy without one session's entry. */
function without<T>(bySession: Record<string, T>, id: string): Record<string, T> {
  if (!(id in bySession)) return bySession;
  const next = { ...bySession };
  delete next[id];
  return next;
}

/** Drops keys that are not in `ids`. Used when the same project is re-read. */
function keepOnly<T>(bySession: Record<string, T>, ids: Set<string>): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [id, value] of Object.entries(bySession)) {
    if (ids.has(id)) next[id] = value;
  }
  return next;
}

/** Drops the files a closed or departed session was showing. */
function forgetSessionFiles(id: string) {
  useGraphStore.getState().forget(id);
  useStepStore.getState().forget(id);
}

export function sessionForPane(sessions: Session[], paneId: string): Session | undefined {
  return sessions.find((session) => session.paneId === paneId);
}

/**
 * The session in one pane. Selects the store object itself, so a status tick
 * on another pane does not rebuild this one (`Object.is` stays true).
 */
export function useSessionForPane(projectId: string, paneId: string): Session | undefined {
  return useSessionStore((state) =>
    state.sessions.find(
      (session) => session.projectId === projectId && session.paneId === paneId,
    ),
  );
}

/**
 * Sessions that belong to this project. The store can still hold the previous
 * project's list until `loadSessions` returns; anything that draws panes or
 * rails has to filter, or a reused pane id shows the last project's session.
 *
 * This allocates a new array every call. Do not use it as a Zustand selector:
 * React 19's `useSyncExternalStore` loops if `getSnapshot` returns a fresh
 * reference. `useSessionsForProject` is the hook that is safe to render with.
 */
export function sessionsForProject(sessions: Session[], projectId: string): Session[] {
  return sessions.filter((session) => session.projectId === projectId);
}

/**
 * Filtered list for render. Selects the store's `sessions` array (stable until
 * the store replaces it) and filters in `useMemo`, so `getSnapshot` never
 * returns a fresh reference. Prefer this over putting `sessionsForProject` or
 * `useShallow` in the selector.
 */
export function useSessionsForProject(projectId: string): Session[] {
  const sessions = useSessionStore((state) => state.sessions);
  return useMemo(
    () => sessionsForProject(sessions, projectId),
    [sessions, projectId],
  );
}
