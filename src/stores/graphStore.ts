import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import {
  parseGraph,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type ParseResult,
} from "../lib/graph";
import { createWatchedSessionMap } from "../lib/watchedSessionMap";
import type { GraphSnapshot } from "../types";

/**
 * One graph per session, kept in step with the files on disk.
 *
 * The backend watches the graph directory and says which session changed; this
 * store re-reads that session's file. Two timings matter:
 *
 * - A burst of writes (a run updating several node statuses at once) is coalesced,
 *   so the canvas is not rebuilt for every intermediate state.
 * - A file caught mid-write is not valid JSON. Rather than flashing an error that a
 *   moment later fixes itself, that one failure is read again before it is shown.
 *   A file that parses but describes no graph is reported the first time.
 */

/** How long to give a writer to finish before broken JSON is believed. */
const RETRY_MS = 150;

/**
 * A live watcher re-read past this size keeps the last drawable graph. The
 * backend still allows 4MB on a first load; parsing that on every 80ms
 * coalesce is what froze the pane.
 */
const LIVE_GRAPH_BYTES = 512 * 1024;

/**
 * Whether the file was JSON at all, which is the one failure worth reading again.
 *
 * `parseGraph` is deliberately not called in here. It reports a document that is
 * not a graph rather than throwing, so folding it in would make the narrow retry
 * depend on that staying true instead of on the shape of this code.
 */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export interface GraphEntry {
  /** The file that was read, or the one the session has been told to write. */
  path: string;
  graph: GraphDocument | null;
  warnings: string[];
  error: string | null;
  /** Modification time of the file the graph came from. */
  updatedAt: number | null;
  /** Byte length of the last `json` we parsed or skipped, for cheap equality. */
  bytes: number | null;
  /** True until the first read of this session's file has completed. */
  isLoading: boolean;
}

interface GraphStoreState {
  bySession: Record<string, GraphEntry>;
  /** Watch / ask failures; per-session graph errors live on each entry. */
  error: string | null;

  /** Reads a session's graph now; safe to call repeatedly. */
  load: (sessionId: string) => Promise<void>;
  /**
   * Replaces held graphs with one project listing. A newer call wins, so
   * switching projects cannot leave the last project's files standing.
   */
  syncSessions: (projectId: string) => Promise<void>;
  /**
   * Coalesced re-read, driven by the backend's change event. `isOpenSession`
   * says whether a session with that id is still open, which the caller knows
   * and this store does not.
   */
  refresh: (sessionId: string, isOpenSession: boolean) => void;
  /** Drops a session's graph, for a session that has been closed or replaced. */
  forget: (sessionId: string) => void;
  /** Starts the project's graph directory watch. Asking twice is harmless. */
  watch: (projectId: string) => Promise<void>;
  setError: (error: string) => void;
  clearError: () => void;
}

const EMPTY: GraphEntry = {
  path: "",
  graph: null,
  warnings: [],
  error: null,
  updatedAt: null,
  bytes: null,
  isLoading: true,
};

/** Drops in-flight `syncSessions` work that a newer project switch has replaced. */
let syncGeneration = 0;

function entryFromSnapshot(snapshot: GraphSnapshot, previous: GraphEntry | undefined): GraphEntry {
  const bytes = snapshot.json?.length ?? 0;
  if (
    previous !== undefined &&
    !previous.isLoading &&
    snapshot.updatedAt !== null &&
    previous.updatedAt === snapshot.updatedAt &&
    previous.bytes === bytes
  ) {
    return previous;
  }

  if (snapshot.tooLarge) {
    return {
      path: snapshot.path,
      graph: null,
      warnings: [],
      error: "The graph file is too large to read.",
      updatedAt: snapshot.updatedAt,
      bytes: null,
      isLoading: false,
    };
  }

  if (snapshot.json === null) {
    return {
      path: snapshot.path,
      graph: null,
      warnings: [],
      error: null,
      updatedAt: snapshot.updatedAt,
      bytes: 0,
      isLoading: false,
    };
  }

  if (previous?.graph != null && snapshot.json.length > LIVE_GRAPH_BYTES) {
    return { ...previous, updatedAt: snapshot.updatedAt, bytes };
  }

  const document = parseJson(snapshot.json);
  if (!document.ok) {
    return {
      path: snapshot.path,
      graph: null,
      warnings: [],
      error: "The graph file is not valid JSON.",
      updatedAt: snapshot.updatedAt,
      bytes,
      isLoading: false,
    };
  }

  const parsed: ParseResult = parseGraph(document.value);
  return parsed.ok
    ? {
        path: snapshot.path,
        graph: stabilizeGraph(previous?.graph ?? null, parsed.graph),
        warnings: parsed.warnings,
        error: null,
        updatedAt: snapshot.updatedAt,
        bytes,
        isLoading: false,
      }
    : {
        path: snapshot.path,
        graph: null,
        warnings: [],
        error: parsed.error,
        updatedAt: snapshot.updatedAt,
        bytes,
        isLoading: false,
      };
}

function sameNode(left: GraphNode, right: GraphNode): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.label === right.label &&
    left.status === right.status &&
    left.role === right.role &&
    left.position.x === right.position.x &&
    left.position.y === right.position.y &&
    left.data.description === right.data.description &&
    left.data.model === right.data.model &&
    left.data.effort === right.data.effort &&
    left.data.parallelism === right.data.parallelism &&
    left.data.worktree === right.data.worktree &&
    left.data.artifactPath === right.data.artifactPath
  );
}

function sameEdge(left: GraphEdge, right: GraphEdge): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.target === right.target &&
    left.label === right.label &&
    left.type === right.type &&
    left.animated === right.animated
  );
}

/**
 * Reuses previous node/edge objects when the parsed file did not change them,
 * so React Flow can skip a full reconcile.
 */
export function stabilizeGraph(
  previous: GraphDocument | null,
  next: GraphDocument,
): GraphDocument {
  if (previous === null) return next;
  if (
    previous.nodes.length !== next.nodes.length ||
    previous.edges.length !== next.edges.length
  ) {
    return next;
  }

  const nodes = next.nodes.map((node, index) => {
    const prior = previous.nodes[index];
    return prior !== undefined && sameNode(prior, node) ? prior : node;
  });
  const edges = next.edges.map((edge, index) => {
    const prior = previous.edges[index];
    return prior !== undefined && sameEdge(prior, edge) ? prior : edge;
  });
  const nodesSame = nodes.every((node, index) => node === previous.nodes[index]);
  const edgesSame = edges.every((edge, index) => edge === previous.edges[index]);
  if (
    nodesSame &&
    edgesSame &&
    previous.id === next.id &&
    previous.name === next.name &&
    previous.status === next.status &&
    previous.topology === next.topology &&
    previous.state?.notes === next.state?.notes
  ) {
    return previous;
  }
  return { ...next, nodes, edges };
}

/** Timers live outside the store: they are plumbing, not state to render. */
const coalesce = createWatchedSessionMap({ onClosed: "keep-if-present" });

export const useGraphStore = create<GraphStoreState>((set, get) => {
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
      // Shown rather than swallowed: this is the only report a pane gets that the
      // file it is pointing at could not be read. The one case that stays quiet is
      // a session already forgotten here, and `write` is what drops it.
      write(sessionId, { isLoading: false, error: errorMessage(error) });
      return;
    }

    if (
      allowRetry &&
      snapshot.json !== null &&
      !snapshot.tooLarge &&
      !parseJson(snapshot.json).ok
    ) {
      // Probably a half-written file. Give the writer a moment, then believe it.
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      if (!(sessionId in get().bySession)) return;
      return read(sessionId, false);
    }

    const existing = get().bySession[sessionId];
    const next = entryFromSnapshot(snapshot, existing);
    if (next === existing) return;
    write(sessionId, next);
  };

  return {
    bySession: {},
    error: null,

    load: async (sessionId) => {
      set((state) =>
        sessionId in state.bySession
          ? state
          : { bySession: { ...state.bySession, [sessionId]: { ...EMPTY } } },
      );
      await read(sessionId, true);
    },

    syncSessions: async (projectId) => {
      const generation = ++syncGeneration;
      try {
        const snapshots = await api.listSessionGraphs(projectId);
        if (generation !== syncGeneration) return;
        const arriving = new Set(snapshots.map((item) => item.sessionId));
        for (const id of Object.keys(get().bySession)) {
          if (!arriving.has(id)) get().forget(id);
        }
        set((state) => {
          const bySession = { ...state.bySession };
          for (const snapshot of snapshots) {
            bySession[snapshot.sessionId] = entryFromSnapshot(
              snapshot,
              bySession[snapshot.sessionId],
            );
          }
          return { bySession, error: null };
        });
      } catch (error) {
        if (generation !== syncGeneration) return;
        set({ error: errorMessage(error) });
      }
    },

    refresh: (sessionId, isOpenSession) => {
      // Closing a session leaves its file and its project's watcher behind.
      // keep-if-present: a graph already on screen is re-read; a late write
      // for a session we never held is ignored.
      coalesce.refresh(sessionId, isOpenSession, {
        hasEntry: () => sessionId in get().bySession,
        load: () => void get().load(sessionId),
        forget: () => get().forget(sessionId),
      });
    },

    forget: (sessionId) => {
      coalesce.cancel(sessionId);
      set((state) => {
        if (!(sessionId in state.bySession)) return state;
        const bySession = { ...state.bySession };
        delete bySession[sessionId];
        return { bySession };
      });
    },

    watch: async (projectId) => {
      try {
        await api.watchProjectGraphs(projectId);
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },

    setError: (error) => set({ error }),
    clearError: () => set({ error: null }),
  };
});

/** The entry for a session, or a stand-in so callers need no null checks. */
export function graphFor(
  bySession: Record<string, GraphEntry>,
  sessionId: string | undefined,
): GraphEntry {
  return (sessionId !== undefined ? bySession[sessionId] : undefined) ?? EMPTY;
}
