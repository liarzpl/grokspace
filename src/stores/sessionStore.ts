import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import { disposeTerminal } from "../lib/terminals";
import type { Session, SessionKind } from "../types";
import { useGraphStore } from "./graphStore";

/** A pane holds at most one session, so starting in a pane displaces the old one. */
function replaceInPane(sessions: Session[], next: Session): Session[] {
  return [
    ...sessions.filter((session) => session.id !== next.id && session.paneId !== next.paneId),
    next,
  ];
}

interface StartInput {
  projectId: string;
  paneId: string;
  kind: SessionKind;
  cols: number;
  rows: number;
}

/** A pane shows either its terminal or the graph the session is reporting. */
export type PaneView = "terminal" | "graph";

interface SessionState {
  sessions: Session[];
  /** Panes with a start or restart in flight, so the UI can show progress. */
  busyPanes: Record<string, boolean>;
  /** Which of its two faces each pane is showing; panes default to terminal. */
  paneViews: Record<string, PaneView>;
  maximizedPane: string | null;
  isLoading: boolean;
  error: string | null;

  loadSessions: (projectId: string) => Promise<void>;
  startSession: (input: StartInput) => Promise<Session | null>;
  stopSession: (id: string) => Promise<void>;
  restartSession: (id: string, cols: number, rows: number) => Promise<Session | null>;
  renameSession: (id: string, title: string) => Promise<void>;
  closeSession: (id: string) => Promise<void>;
  markExited: (id: string, exitCode: number | null) => void;
  toggleMaximized: (paneId: string) => void;
  setPaneView: (paneId: string, view: PaneView) => void;
  clearError: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  busyPanes: {},
  paneViews: {},
  maximizedPane: null,
  isLoading: false,
  error: null,

  clearError: () => set({ error: null }),

  toggleMaximized: (paneId) =>
    set((state) => ({ maximizedPane: state.maximizedPane === paneId ? null : paneId })),

  setPaneView: (paneId, view) =>
    set((state) => ({ paneViews: { ...state.paneViews, [paneId]: view } })),

  loadSessions: async (projectId) => {
    // Pane state belongs to the project being left, not the one arriving.
    set({ isLoading: true, error: null, maximizedPane: null, paneViews: {} });
    try {
      set({ sessions: await api.listSessions(projectId), isLoading: false });
    } catch (error) {
      set({ error: errorMessage(error), isLoading: false });
    }
  },

  startSession: async (input) => {
    set((state) => ({ busyPanes: { ...state.busyPanes, [input.paneId]: true }, error: null }));
    try {
      const session = await api.createSession(input);
      set((state) => ({
        sessions: replaceInPane(state.sessions, session),
        // A pane left showing the previous session's graph should greet a new
        // session with its terminal, which is the thing that needs watching.
        paneViews: { ...state.paneViews, [input.paneId]: "terminal" },
      }));
      return session;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    } finally {
      set((state) => ({ busyPanes: { ...state.busyPanes, [input.paneId]: false } }));
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
      disposeTerminal(id);
      useGraphStore.getState().forget(id);
      set((state) => ({
        sessions: replaceInPane(
          state.sessions.filter((existing) => existing.id !== id),
          session,
        ),
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
      useGraphStore.getState().forget(id);
      set((state) => ({ sessions: state.sessions.filter((session) => session.id !== id) }));
    } catch (error) {
      set({ error: errorMessage(error) });
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
    })),
}));

export function sessionForPane(sessions: Session[], paneId: string): Session | undefined {
  return sessions.find((session) => session.paneId === paneId);
}
