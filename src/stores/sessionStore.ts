import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { api, errorMessage } from "../lib/api";
import { briefPrompt, type Role } from "../lib/roles";
import { detachTerminal, disposeTerminal } from "../lib/terminals";
import { foldUpdate } from "../lib/transcript";
import type {
  AgentUpdate,
  PermissionRequest,
  Session,
  SessionKind,
  SessionStatus,
} from "../types";
import { useGraphStore } from "./graphStore";
import { useStepStore } from "./stepStore";

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

interface StartInput {
  projectId: string;
  /** Absent for an agent, which runs beside the grid rather than in it. */
  paneId: string | null;
  kind: SessionKind;
  /** What it is being started as, when it is being started as anything. */
  role?: string;
  cols: number;
  rows: number;
}

/** A session started for a role has not been measured, so it starts classic. */
const FALLBACK_SIZE = { cols: 80, rows: 24 };

/** A pane shows its terminal, the graph the session is reporting, or its steps. */
export type PaneView = "terminal" | "graph" | "tasks";

interface SessionState {
  sessions: Session[];
  /** Panes with a start or restart in flight, so the UI can show progress. */
  busyPanes: Record<string, boolean>;
  /** Which of its faces each pane is showing; panes default to terminal. */
  paneViews: Record<string, PaneView>;
  maximizedPane: string | null;
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
  isLoading: boolean;
  error: string | null;

  loadSessions: (projectId: string) => Promise<void>;
  startSession: (input: StartInput) => Promise<Session | null>;
  /**
   * Starts one agent per role and tells each what it is for. Returns the roles that
   * would not start, so the caller can say which rather than only that some did.
   */
  launchSwarm: (projectId: string, roles: readonly Role[]) => Promise<string[]>;
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
   */
  mergeWorktree: (id: string) => Promise<void>;
  markExited: (id: string, exitCode: number | null) => void;
  /** From the backend's status event, which only agents emit. */
  markStatus: (id: string, status: SessionStatus) => void;
  /** From the backend's permission event. */
  askPermission: (id: string, request: PermissionRequest) => void;
  answerPermission: (id: string, requestId: number, allow: boolean) => Promise<void>;
  /** From the backend's `session-update` event. */
  appendUpdate: (id: string, update: AgentUpdate) => void;
  /** Sends a follow-up to an idle agent. */
  promptSession: (id: string, text: string) => Promise<void>;
  /** Interrupts the current turn without ending the session. */
  cancelSession: (id: string) => Promise<void>;
  toggleMaximized: (paneId: string) => void;
  setPaneView: (paneId: string, view: PaneView) => void;
  clearError: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  busyPanes: {},
  paneViews: {},
  maximizedPane: null,
  permissions: {},
  transcript: {},
  isLoading: false,
  error: null,

  clearError: () => set({ error: null }),

  toggleMaximized: (paneId) =>
    set((state) => ({ maximizedPane: state.maximizedPane === paneId ? null : paneId })),

  setPaneView: (paneId, view) =>
    set((state) => ({ paneViews: { ...state.paneViews, [paneId]: view } })),

  loadSessions: async (projectId) => {
    const generation = ++loadGeneration;
    const leaving = get().sessions;
    // Pane ids are reused across projects. Until this fetch returns, the grid
    // would keep drawing the previous project's terminals — including a Grok TUI
    // that then sits on the wrong folder. Drop them now; a same-project reload
    // must not, or overlapping graphs and live xterms go blank.
    const switching = leaving.some((session) => session.projectId !== projectId);
    set({
      isLoading: true,
      error: null,
      maximizedPane: null,
      paneViews: {},
      ...(switching ? { sessions: [], permissions: {}, busyPanes: {} } : {}),
    });
    if (switching) {
      for (const session of leaving) {
        detachTerminal(session.id);
        forgetSessionFiles(session.id);
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
        transcript: switching ? state.transcript : keepOnly(state.transcript, arriving),
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
      });
    }
  },

  startSession: async (input) => {
    // An agent has no pane, so there is no pane to mark busy or to switch back to
    // its terminal. Keying either on `null` would invent a pane called "null".
    const paneId = input.paneId;
    const busy = (value: boolean) =>
      paneId === null ? {} : { busyPanes: { ...get().busyPanes, [paneId]: value } };

    set((state) => ({ ...busy(true), error: null, permissions: state.permissions }));
    try {
      const session = await api.createSession(input);
      set((state) => ({
        sessions: replaceInPane(state.sessions, session),
        // A pane left showing the previous session's graph should greet a new
        // session with its terminal, which is the thing that needs watching.
        paneViews:
          paneId === null ? state.paneViews : { ...state.paneViews, [paneId]: "terminal" },
      }));
      return session;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    } finally {
      set(() => busy(false));
    }
  },

  launchSwarm: async (projectId, roles) => {
    const failed: string[] = [];
    for (const role of roles) {
      // Sequential, and one role's failure does not stop the rest: five roles are
      // five independent sessions, and throwing four away because the fifth could
      // not start would be the wrong trade. They are agents rather than terminals
      // because five of them do not fit in a six-pane grid, and because an agent is
      // the kind that can report what it is doing.
      const session = await get().startSession({
        projectId,
        paneId: null,
        kind: "agent",
        role: role.name,
        ...FALLBACK_SIZE,
      });
      if (session === null) {
        failed.push(role.name);
        continue;
      }

      try {
        await api.promptSession(session.id, briefPrompt(role));
      } catch (error) {
        // Started but never briefed, which is worse than not started: it would sit
        // there looking ready while knowing nothing about its job.
        set({ error: errorMessage(error) });
        failed.push(role.name);
      }
    }
    return failed;
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
      disposeTerminal(id);
      forgetSessionFiles(id);
      set((state) => ({
        sessions: replaceInPane(
          state.sessions.filter((existing) => existing.id !== id),
          session,
        ),
        transcript: without(state.transcript, id),
      }));
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
      disposeTerminal(id);
      forgetSessionFiles(id);
      set((state) => ({
        sessions: state.sessions.filter((session) => session.id !== id),
        permissions: without(state.permissions, id),
        transcript: without(state.transcript, id),
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  discardWorktree: async (id) => {
    try {
      const session = await api.discardSessionWorktree(id);
      set((state) => ({
        sessions: state.sessions.map((existing) =>
          existing.id === id ? session : existing,
        ),
        error: null,
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  mergeWorktree: async (id) => {
    try {
      const session = await api.mergeSessionWorktree(id);
      set((state) => ({
        sessions: state.sessions.map((existing) =>
          existing.id === id ? session : existing,
        ),
        error: null,
      }));
    } catch (error) {
      const message = errorMessage(error);
      // The branch is already on the project; only teardown failed. The backend
      // cleared worktree_path, so the chip must go too or Merge offers a retry
      // that says "nothing to merge".
      if (message.includes("the branch landed")) {
        set((state) => ({
          sessions: state.sessions.map((existing) =>
            existing.id === id ? { ...existing, worktreePath: null } : existing,
          ),
          error: message,
        }));
        return;
      }
      set({ error: message });
    }
  },

  /**
   * Driven by the backend's exit event. Sessions that were closed rather than
   * stopped are already gone from the list, and their late exit event is a
   * no-op here.
   */
  markExited: (id, exitCode) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, status: "stopped" as const, exitCode, processId: null }
          : session,
      ),
      // Nothing can answer what a session that has gone was asking.
      permissions: without(state.permissions, id),
    })),

  markStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, status } : session,
      ),
    })),

  askPermission: (id, request) =>
    set((state) => {
      if (!state.sessions.some((session) => session.id === id)) return state;
      return {
        permissions: {
          ...state.permissions,
          // Appended rather than replaced: an agent can be blocked on more than one,
          // and each has its own id to answer.
          [id]: [...(state.permissions[id] ?? []), request],
        },
      };
    }),

  answerPermission: async (id, requestId, allow) => {
    try {
      await api.answerSessionPermission(id, requestId, allow);
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

  appendUpdate: (id, update) =>
    set((state) => ({
      transcript: {
        ...state.transcript,
        [id]: foldUpdate(state.transcript[id] ?? [], update),
      },
    })),

  promptSession: async (id, text) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    try {
      await api.promptSession(id, trimmed);
      get().appendUpdate(id, { kind: "prompt", text: trimmed });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  cancelSession: async (id) => {
    try {
      await api.cancelSession(id);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },
}));

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

/** Filtered list for render. Same session objects, stable array identity. */
export function useSessionsForProject(projectId: string): Session[] {
  return useSessionStore(
    useShallow((state) => sessionsForProject(state.sessions, projectId)),
  );
}
