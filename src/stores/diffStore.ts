import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import type { ChangedFile, DiffState } from "../types";

/**
 * What the agents have changed, as git sees it.
 *
 * Read on demand rather than watched. A file watcher over a whole project would fire
 * on every build artifact an agent's test run produces, and the useful moment to look
 * at a diff is the one where somebody asks — so there is a Refresh, and it is honest
 * about being a snapshot.
 *
 * `scope` is a session id when the panel is looking at that agent's worktree, or
 * null for the project's own tree.
 */

const NOTHING: DiffState = { state: "clean", branch: null };

/** Drops in-flight `loadDiff` results that a newer project or scope has replaced. */
let loadGeneration = 0;

interface DiffStoreState {
  diff: DiffState;
  /** The file whose diff is on screen, and the diff itself. */
  selected: string | null;
  body: string;
  /**
   * Which tree is on screen. Null is the project; a session id is that agent's
   * worktree. The chips write this by calling `loadDiff` with the id.
   */
  scope: string | null;
  isLoading: boolean;
  isLoadingBody: boolean;
  error: string | null;

  loadDiff: (projectId: string, sessionId?: string | null) => Promise<void>;
  selectFile: (projectId: string, file: ChangedFile) => Promise<void>;
  clearError: () => void;
}

export const useDiffStore = create<DiffStoreState>((set, get) => ({
  diff: NOTHING,
  selected: null,
  body: "",
  scope: null,
  isLoading: false,
  isLoadingBody: false,
  error: null,

  clearError: () => set({ error: null }),

  loadDiff: async (projectId, sessionId = null) => {
    const generation = ++loadGeneration;
    set({ isLoading: true, error: null, scope: sessionId ?? null });
    try {
      // The selection is dropped, not kept: a refresh can find the file committed or
      // reverted, and a body left on screen would describe a change that is gone.
      const diff = await api.projectDiff(projectId, sessionId ?? null);
      if (generation !== loadGeneration) return;
      set({ diff, selected: null, body: "", isLoading: false });
    } catch (error) {
      if (generation !== loadGeneration) return;
      set({
        error: errorMessage(error),
        isLoading: false,
        diff: NOTHING,
        selected: null,
        body: "",
      });
    }
  },

  selectFile: async (projectId, file) => {
    set({ selected: file.path, body: "", isLoadingBody: true });
    try {
      const body = await api.fileDiff(
        projectId,
        file.path,
        file.change === "untracked",
        get().scope,
      );
      set({ body, isLoadingBody: false });
    } catch (error) {
      // The size ceiling lands here, and it is the kind of refusal worth reading, so
      // the selection stays and the reason goes on the banner.
      set({ error: errorMessage(error), isLoadingBody: false });
    }
  },
}));

/** How many files changed, for the header to say without opening the panel. */
export function changedCount(diff: DiffState): number {
  return diff.state === "changed" ? diff.files.length : 0;
}
