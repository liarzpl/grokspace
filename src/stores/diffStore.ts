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
 */

const NOTHING: DiffState = { state: "clean", branch: null };

interface DiffStoreState {
  diff: DiffState;
  /** The file whose diff is on screen, and the diff itself. */
  selected: string | null;
  body: string;
  isLoading: boolean;
  isLoadingBody: boolean;
  error: string | null;

  loadDiff: (projectId: string) => Promise<void>;
  selectFile: (projectId: string, file: ChangedFile) => Promise<void>;
  clearError: () => void;
}

export const useDiffStore = create<DiffStoreState>((set) => ({
  diff: NOTHING,
  selected: null,
  body: "",
  isLoading: false,
  isLoadingBody: false,
  error: null,

  clearError: () => set({ error: null }),

  loadDiff: async (projectId) => {
    set({ isLoading: true, error: null });
    try {
      // The selection is dropped, not kept: a refresh can find the file committed or
      // reverted, and a body left on screen would describe a change that is gone.
      set({ diff: await api.projectDiff(projectId), selected: null, body: "", isLoading: false });
    } catch (error) {
      set({ error: errorMessage(error), isLoading: false });
    }
  },

  selectFile: async (projectId, file) => {
    set({ selected: file.path, body: "", isLoadingBody: true });
    try {
      const body = await api.fileDiff(projectId, file.path, file.change === "untracked");
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
