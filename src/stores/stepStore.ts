import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import { createWatchedSessionMap } from "../lib/watchedSessionMap";
import type { SessionStep, SessionSteps, StepsPhase } from "../types";

/**
 * One step list per session, kept in step with SQLite (and the inbound file the
 * backend folds into it).
 *
 * The backend watches the steps directory and says which session changed; this
 * store re-reads that session. A burst of writes is coalesced so the checklist
 * is not rebuilt for every intermediate save.
 */

/** Drops in-flight `syncSessions` work that a newer project switch has replaced. */
let syncGeneration = 0;

/** Bumped on reset/forget so an in-flight `load` cannot restore a list we cleared. */
const epochs = new Map<string, number>();

function bump(sessionId: string): void {
  epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
}

export interface StepEntry {
  sessionId: string;
  phase: StepsPhase;
  steps: SessionStep[];
  /** True until the first read of this session's list has completed. */
  isLoading: boolean;
}

interface StepState {
  bySession: Record<string, StepEntry>;
  error: string | null;

  /** Reads a session's list now; safe to call repeatedly. */
  load: (sessionId: string) => Promise<void>;
  /**
   * Replaces the held lists with those of the sessions that are now on screen.
   * A newer call wins, so switching projects cannot leave the last project's
   * checklists standing.
   */
  syncSessions: (sessionIds: readonly string[]) => Promise<void>;
  /**
   * Coalesced re-read, driven by the backend's change event. `isOpenSession`
   * says whether a session with that id is still open, which the caller knows
   * and this store does not.
   */
  refresh: (sessionId: string, isOpenSession: boolean) => void;
  /** Drops a session's list, for a session that has been closed or replaced. */
  forget: (sessionId: string) => void;
  /**
   * Empties a session's list in place. Dispatching a new job onto it is a new
   * list, and the board should not keep showing the last job's tally.
   */
  reset: (sessionId: string) => void;
  add: (sessionId: string, title: string) => Promise<boolean>;
  update: (id: string, changes: { title?: string; status?: SessionStep["status"] }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reorder: (sessionId: string, ids: string[]) => Promise<void>;
  /** Locks titles and order. The caller is the one that then prompts the agent. */
  approve: (sessionId: string) => Promise<SessionSteps | null>;
  /** Undoes Approve when the prompt never landed, so the button comes back. */
  reopen: (sessionId: string) => Promise<void>;
  /** Starts the project's steps directory watch. Asking twice is harmless. */
  watch: (projectId: string) => Promise<void>;
  setError: (error: string) => void;
  clearError: () => void;
}

const EMPTY: StepEntry = {
  sessionId: "",
  phase: "none",
  steps: [],
  isLoading: true,
};

function fromSnapshot(snapshot: SessionSteps): StepEntry {
  return {
    sessionId: snapshot.sessionId,
    phase: snapshot.phase,
    steps: snapshot.steps,
    isLoading: false,
  };
}

/** Timers live outside the store: they are plumbing, not state to render. */
const coalesce = createWatchedSessionMap({ onClosed: "forget" });

export const useStepStore = create<StepState>((set, get) => {
  const write = (sessionId: string, changes: Partial<StepEntry>) =>
    set((state) => {
      // A session forgotten while its read was in flight must not come back.
      if (!(sessionId in state.bySession)) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...(state.bySession[sessionId] ?? EMPTY), ...changes },
        },
      };
    });

  const put = (snapshot: SessionSteps) =>
    set((state) => {
      // Forgotten on purpose: an in-flight add/approve must not resurrect it.
      if (!(snapshot.sessionId in state.bySession)) return state;
      return {
        bySession: {
          ...state.bySession,
          [snapshot.sessionId]: fromSnapshot(snapshot),
        },
      };
    });

  return {
    bySession: {},
    error: null,

    setError: (error) => set({ error }),
    clearError: () => set({ error: null }),

    watch: async (projectId) => {
      try {
        await api.watchProjectSteps(projectId);
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

    load: async (sessionId) => {
      const epoch = epochs.get(sessionId) ?? 0;
      set((state) =>
        sessionId in state.bySession
          ? state
          : { bySession: { ...state.bySession, [sessionId]: { ...EMPTY, sessionId } } },
      );
      try {
        const snapshot = await api.listSessionSteps(sessionId);
        if ((epochs.get(sessionId) ?? 0) !== epoch) return;
        write(sessionId, fromSnapshot(snapshot));
      } catch (error) {
        if ((epochs.get(sessionId) ?? 0) !== epoch) return;
        write(sessionId, { isLoading: false });
        if (sessionId in get().bySession) set({ error: errorMessage(error) });
      }
    },

    syncSessions: async (sessionIds) => {
      const generation = ++syncGeneration;
      const arriving = new Set(sessionIds);
      for (const id of Object.keys(get().bySession)) {
        if (!arriving.has(id)) get().forget(id);
      }
      await Promise.all(sessionIds.map((id) => get().load(id)));
      if (generation !== syncGeneration) return;
    },

    refresh: (sessionId, isOpenSession) => {
      // Closing a session CASCADE-deletes its rows. A re-read would only be an
      // error, so the closed-session policy is forget.
      coalesce.refresh(sessionId, isOpenSession, {
        hasEntry: () => sessionId in get().bySession,
        load: () => void get().load(sessionId),
        forget: () => get().forget(sessionId),
      });
    },

    forget: (sessionId) => {
      bump(sessionId);
      coalesce.cancel(sessionId);
      set((state) => {
        if (!(sessionId in state.bySession)) return state;
        const bySession = { ...state.bySession };
        delete bySession[sessionId];
        return { bySession };
      });
    },

    reset: (sessionId) => {
      bump(sessionId);
      coalesce.cancel(sessionId);
      set((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: { sessionId, phase: "none", steps: [], isLoading: false },
        },
      }));
    },

    add: async (sessionId, title) => {
      try {
        put(await api.addSessionStep(sessionId, title));
        return true;
      } catch (error) {
        set({ error: errorMessage(error) });
        return false;
      }
    },

    update: async (id, changes) => {
      try {
        put(await api.updateSessionStep(id, changes));
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

    remove: async (id) => {
      try {
        put(await api.removeSessionStep(id));
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

    reorder: async (sessionId, ids) => {
      try {
        put(await api.reorderSessionSteps(sessionId, ids));
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

    approve: async (sessionId) => {
      try {
        const snapshot = await api.approveSessionSteps(sessionId);
        put(snapshot);
        return snapshot;
      } catch (error) {
        set({ error: errorMessage(error) });
        return null;
      }
    },

    reopen: async (sessionId) => {
      try {
        put(await api.reopenSessionSteps(sessionId));
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

  };
});

/** The entry for a session, or a stand-in so callers need no null checks. */
export function stepsFor(
  bySession: Record<string, StepEntry>,
  sessionId: string | undefined,
): StepEntry {
  return (sessionId !== undefined ? bySession[sessionId] : undefined) ?? EMPTY;
}
