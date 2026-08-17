import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import { parseGraph, type GraphDocument } from "../lib/graph";
import type { SkillStatus } from "../types";

/**
 * One graph per session, kept in step with the files on disk.
 *
 * The backend watches the graph directories and says which session changed; this
 * store re-reads that session's file. Two timings matter:
 *
 * - A burst of writes (a run updating several node statuses at once) is coalesced,
 *   so the canvas is not rebuilt for every intermediate state.
 * - A file caught mid-write parses as broken. Rather than flashing an error that a
 *   moment later fixes itself, a failed parse is retried once before it is shown.
 */

/** Long enough to swallow a burst of writes, short enough to still read as live. */
const COALESCE_MS = 80;

/** How long to give a writer to finish before a parse failure is believed. */
const RETRY_MS = 150;

export interface GraphEntry {
  /** The file that was read, or the one the session has been told to write. */
  path: string;
  graph: GraphDocument | null;
  warnings: string[];
  error: string | null;
  /** Modification time of the file the graph came from. */
  updatedAt: number | null;
  /** True until the first read of this session's file has completed. */
  isLoading: boolean;
}

interface GraphState {
  bySession: Record<string, GraphEntry>;
  /**
   * Whether `grok` has been taught to write these files. Shared rather than
   * per-pane: six empty panes should not ask the backend six times.
   */
  skill: SkillStatus | null;
  isInstallingSkill: boolean;

  /** Reads a session's graph now; safe to call repeatedly. */
  load: (sessionId: string) => Promise<void>;
  /**
   * Coalesced re-read, driven by the backend's change event. `isOpenSession`
   * says whether a session with that id is still open, which the caller knows
   * and this store does not.
   */
  refresh: (sessionId: string, isOpenSession: boolean) => void;
  /** Drops a session's graph, for a session that has been closed or replaced. */
  forget: (sessionId: string) => void;
  loadSkill: () => Promise<void>;
  installSkill: () => Promise<void>;
}

const EMPTY: GraphEntry = {
  path: "",
  graph: null,
  warnings: [],
  error: null,
  updatedAt: null,
  isLoading: true,
};

/** Timers live outside the store: they are plumbing, not state to render. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export const useGraphStore = create<GraphState>((set, get) => {
  const write = (sessionId: string, changes: Partial<GraphEntry>) =>
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

  const read = async (sessionId: string, allowRetry: boolean): Promise<void> => {
    let snapshot;
    try {
      snapshot = await api.readSessionGraph(sessionId);
    } catch (error) {
      // A session the backend has already forgotten is not an error worth
      // showing; the pane it belonged to is going away too.
      write(sessionId, { isLoading: false, error: errorMessage(error) });
      return;
    }

    if (snapshot.json === null) {
      write(sessionId, {
        path: snapshot.path,
        graph: null,
        warnings: [],
        error: null,
        updatedAt: snapshot.updatedAt,
        isLoading: false,
      });
      return;
    }

    let parsed;
    try {
      parsed = parseGraph(JSON.parse(snapshot.json) as unknown);
    } catch {
      parsed = { ok: false as const, error: "The graph file is not valid JSON." };
    }

    if (!parsed.ok && allowRetry) {
      // Probably a half-written file. Give the writer a moment, then believe it.
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      if (!(sessionId in get().bySession)) return;
      return read(sessionId, false);
    }

    write(
      sessionId,
      parsed.ok
        ? {
            path: snapshot.path,
            graph: parsed.graph,
            warnings: parsed.warnings,
            error: null,
            updatedAt: snapshot.updatedAt,
            isLoading: false,
          }
        : {
            path: snapshot.path,
            graph: null,
            warnings: [],
            error: parsed.error,
            updatedAt: snapshot.updatedAt,
            isLoading: false,
          },
    );
  };

  return {
    bySession: {},
    skill: null,
    isInstallingSkill: false,

    load: async (sessionId) => {
      set((state) =>
        sessionId in state.bySession
          ? state
          : { bySession: { ...state.bySession, [sessionId]: { ...EMPTY } } },
      );
      await read(sessionId, true);
    },

    refresh: (sessionId, isOpenSession) => {
      // Closing a session removes it from the workspace but leaves its file and
      // its project's watcher behind, so a late write can name a session that
      // nothing is showing. Reading it would file an entry — an error, once the
      // backend has forgotten the session too — that no pane will ever ask for.
      if (!isOpenSession && !(sessionId in get().bySession)) return;

      const queued = pending.get(sessionId);
      if (queued !== undefined) clearTimeout(queued);
      pending.set(
        sessionId,
        setTimeout(() => {
          pending.delete(sessionId);
          // An open session can write its first graph before anything here has
          // read it, so the entry is created rather than assumed.
          void get().load(sessionId);
        }, COALESCE_MS),
      );
    },

    forget: (sessionId) => {
      const queued = pending.get(sessionId);
      if (queued !== undefined) {
        clearTimeout(queued);
        pending.delete(sessionId);
      }
      set((state) => {
        if (!(sessionId in state.bySession)) return state;
        const bySession = { ...state.bySession };
        delete bySession[sessionId];
        return { bySession };
      });
    },

    loadSkill: async () => {
      if (get().skill !== null) return;
      try {
        set({ skill: await api.graphSkillStatus() });
      } catch {
        // Only used to decide whether to offer the install; a failure here should
        // not put an error banner over a working panel.
      }
    },

    installSkill: async () => {
      set({ isInstallingSkill: true });
      try {
        set({ skill: await api.installGraphSkill() });
      } catch {
        // Left as it was, so the button stays available to try again.
      } finally {
        set({ isInstallingSkill: false });
      }
    },
  };
});

/** The entry for a session, or a stand-in so callers need no null checks. */
export function graphFor(
  bySession: Record<string, GraphEntry>,
  sessionId: string | undefined,
): GraphEntry {
  return (sessionId !== undefined ? bySession[sessionId] : undefined) ?? EMPTY;
}
