import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import type { DiffComment } from "../lib/diffPrompt";
import { overlapsOf } from "../lib/overlap";
import type { ChangedFile, DiffState } from "../types";

/**
 * Whether the last-loaded isolation map lists a path another live tree also
 * touched. Git-missing / not-a-repo / an unread clean snapshot are not an offer.
 */
export function isolationMapHasOverlap(diff: DiffState): boolean {
  return overlapsOf(diff).length > 0;
}

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

const NOTHING: DiffState = { state: "clean", branch: null, overlaps: [] };

function withoutSession(
  comments: Record<string, DiffComment[]>,
  sessionId: string,
): Record<string, DiffComment[]> {
  const next: Record<string, DiffComment[]> = {};
  for (const [id, list] of Object.entries(comments)) {
    if (id !== sessionId) next[id] = list;
  }
  return next;
}

/** Drops in-flight `loadDiff` results that a newer project or scope has replaced. */
let loadGeneration = 0;

/** Drops in-flight file bodies that a newer selection or list load has replaced. */
let bodyGeneration = 0;

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
  /**
   * Review comments keyed by scoped session id. The project tree (null scope)
   * has none. Reload drops the map; that is v1.
   */
  comments: Record<string, DiffComment[]>;

  loadDiff: (projectId: string, sessionId?: string | null) => Promise<void>;
  selectFile: (projectId: string, file: ChangedFile) => Promise<void>;
  /**
   * Opens a path in this session's worktree: the Diff tab's file list if git
   * sees it as changed, otherwise an untracked read so a committed artifact
   * still has somewhere to land.
   */
  openPath: (projectId: string, sessionId: string, path: string) => Promise<void>;
  addComment: (sessionId: string, comment: DiffComment) => void;
  removeComment: (sessionId: string, path: string, hunkIndex: number) => void;
  clearComments: (sessionId: string) => void;
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
  comments: {},

  clearError: () => set({ error: null }),

  addComment: (sessionId, comment) => {
    const text = comment.text.trim();
    if (text === "") return;
    const current = get().comments[sessionId] ?? [];
    const next = [...current];
    const existing = next.findIndex(
      (item) => item.path === comment.path && item.hunkIndex === comment.hunkIndex,
    );
    const stored: DiffComment = { ...comment, text };
    if (existing === -1) next.push(stored);
    else next[existing] = stored;
    set({ comments: { ...get().comments, [sessionId]: next } });
  },

  removeComment: (sessionId, path, hunkIndex) => {
    const current = get().comments[sessionId];
    if (current === undefined) return;
    const next = current.filter(
      (item) => item.path !== path || item.hunkIndex !== hunkIndex,
    );
    if (next.length === current.length) return;
    if (next.length === 0) {
      set({ comments: withoutSession(get().comments, sessionId) });
      return;
    }
    set({ comments: { ...get().comments, [sessionId]: next } });
  },

  clearComments: (sessionId) => {
    if (get().comments[sessionId] === undefined) return;
    set({ comments: withoutSession(get().comments, sessionId) });
  },

  loadDiff: async (projectId, sessionId = null) => {
    const generation = ++loadGeneration;
    // A newer list or worktree chip also invalidates any file body still in flight.
    bodyGeneration += 1;
    set({ isLoading: true, error: null, scope: sessionId ?? null });
    try {
      // The selection is dropped, not kept: a refresh can find the file committed or
      // reverted, and a body left on screen would describe a change that is gone.
      const diff = await api.projectDiff(projectId, sessionId ?? null);
      if (generation !== loadGeneration) return;
      // A click during the request took a newer generation; drop it with the list.
      bodyGeneration += 1;
      set({ diff, selected: null, body: "", isLoading: false, isLoadingBody: false });
    } catch (error) {
      if (generation !== loadGeneration) return;
      bodyGeneration += 1;
      set({
        error: errorMessage(error),
        isLoading: false,
        isLoadingBody: false,
        diff: NOTHING,
        selected: null,
        body: "",
      });
    }
  },

  selectFile: async (projectId, file) => {
    const generation = ++bodyGeneration;
    // Bind the chip that was on screen at the click, not whichever loadDiff wins later.
    const scope = get().scope;
    set({ selected: file.path, body: "", isLoadingBody: true });
    try {
      const body = await api.fileDiff(
        projectId,
        file.path,
        file.change === "untracked",
        scope,
      );
      if (generation !== bodyGeneration) return;
      set({ body, isLoadingBody: false });
    } catch (error) {
      if (generation !== bodyGeneration) return;
      // The size ceiling lands here, and it is the kind of refusal worth reading, so
      // the selection stays and the reason goes on the banner.
      set({ error: errorMessage(error), isLoadingBody: false });
    }
  },

  openPath: async (projectId, sessionId, path) => {
    // loadDiff bumps loadGeneration on entry; if a newer list started after ours,
    // the snapshot we would read (and the scope selectFile would bind) is not ours.
    const listGeneration = loadGeneration + 1;
    const loading = get().loadDiff(projectId, sessionId);
    // Start already bumped bodyGeneration. The winning apply bumps once more;
    // a click on the still-visible old list bumps further, and must win.
    const expectedBody = bodyGeneration + 1;
    await loading;
    if (listGeneration !== loadGeneration) return;
    if (bodyGeneration !== expectedBody) return;
    const { diff } = get();
    if (diff.state === "changed") {
      const file = diff.files.find((candidate) => candidate.path === path);
      if (file !== undefined) {
        await get().selectFile(projectId, file);
        return;
      }
    }
    const bodyGen = ++bodyGeneration;
    set({ selected: path, body: "", isLoadingBody: true, error: null });
    try {
      const body = await api.fileDiff(projectId, path, true, sessionId);
      if (bodyGen !== bodyGeneration) return;
      set({ body, isLoadingBody: false });
    } catch (error) {
      if (bodyGen !== bodyGeneration) return;
      set({ error: errorMessage(error), isLoadingBody: false });
    }
  },
}));
