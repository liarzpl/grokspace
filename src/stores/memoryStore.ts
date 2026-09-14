import { useMemo } from "react";
import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import type { MemoryEntry, MemoryEntryType } from "../types";

/**
 * The project's shared memory: what everyone working on it should already know.
 *
 * Every write returns the whole memory rather than one entry, because the file
 * agents read is rebuilt from all of it — taking the backend's list keeps the panel
 * showing exactly what was written to that file.
 */

/** The order the panel and the generated file both read in. */
export const MEMORY_TYPES: readonly { type: MemoryEntryType; label: string; hint: string }[] = [
  { type: "context", label: "Context", hint: "What the project is and how it fits together" },
  { type: "decision", label: "Decisions", hint: "Choices already made, and why" },
  { type: "note", label: "Notes", hint: "Anything else worth carrying between sessions" },
  { type: "artifact", label: "Artifacts", hint: "Where things ended up: paths, outputs, endpoints" },
];

/** Drops in-flight `loadMemory` results that a newer project switch has replaced. */
let loadGeneration = 0;

/** True before the first load (tests, first paint) or while this project is still current. */
function stillThisProject(loaded: string | null, projectId: string): boolean {
  return loaded === null || loaded === projectId;
}

interface MemoryState {
  entries: MemoryEntry[];
  /** Project whose `entries` and `filePath` belong to, or null before the first load. */
  projectId: string | null;
  /** The file agents are told to read, named so a missing one stays discoverable. */
  filePath: string;
  isLoading: boolean;
  error: string | null;

  loadMemory: (projectId: string) => Promise<void>;
  /** Writes an entry, replacing whatever was under that key. */
  createEntry: (
    projectId: string,
    entry: { key: string; content: string; type: MemoryEntryType },
  ) => Promise<boolean>;
  /** @deprecated Use `createEntry`. Alias for one release. */
  putEntry: (
    projectId: string,
    entry: { key: string; content: string; type: MemoryEntryType },
  ) => Promise<boolean>;
  removeEntry: (projectId: string, key: string) => Promise<void>;
  /** @deprecated Use `removeEntry`. Alias for one release. */
  forgetEntry: (projectId: string, key: string) => Promise<void>;
  clearError: () => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  entries: [],
  projectId: null,
  filePath: "",
  isLoading: false,
  error: null,

  clearError: () => set({ error: null }),

  loadMemory: async (projectId) => {
    const generation = ++loadGeneration;
    const leaving = get().entries;
    // Until this fetch returns, the panel would keep the previous project's
    // rows clickable — Save would write the old key into the new project.
    // Drop them now; a same-project reload must not, or the list flashes empty.
    const switching =
      (get().projectId !== null && get().projectId !== projectId) ||
      leaving.some((entry) => entry.projectId !== projectId);
    set({
      isLoading: true,
      error: null,
      projectId,
      ...(switching ? { entries: [], filePath: "" } : {}),
    });
    try {
      // Both together: the path belongs to the project being loaded, and asking for
      // it separately would leave the panel naming the last project's file.
      const [entries, filePath] = await Promise.all([
        api.listMemory(projectId),
        api.memoryFilePath(projectId),
      ]);
      if (generation !== loadGeneration) return;
      set({ entries, filePath, isLoading: false });
    } catch (error) {
      if (generation !== loadGeneration) return;
      set({ error: errorMessage(error), isLoading: false, entries: [], filePath: "" });
    }
  },

  createEntry: async (projectId, entry) => {
    try {
      const entries = await api.putMemory(projectId, entry);
      // False, not true: NewEntryForm / EntryRow treat true as "clear the draft".
      if (!stillThisProject(get().projectId, projectId)) return false;
      set({ entries, error: null });
      return true;
    } catch (error) {
      // Reported rather than swallowed: the cap and the empty-key rule both land
      // here, and both are things someone needs told — unless we already left.
      if (stillThisProject(get().projectId, projectId)) {
        set({ error: errorMessage(error) });
      }
      return false;
    }
  },

  removeEntry: async (projectId, key) => {
    try {
      const entries = await api.removeMemory(projectId, key);
      if (!stillThisProject(get().projectId, projectId)) return;
      set({ entries });
    } catch (error) {
      if (stillThisProject(get().projectId, projectId)) {
        set({ error: errorMessage(error) });
      }
    }
  },

  putEntry: (projectId, entry) => get().createEntry(projectId, entry),
  forgetEntry: (projectId, key) => get().removeEntry(projectId, key),
}));

/** The entries of one type, in the order the backend returned them. */
export function entriesOfType(entries: MemoryEntry[], type: MemoryEntryType): MemoryEntry[] {
  return entries.filter((entry) => entry.type === type);
}

/**
 * Entries that belong to this project. Do not use as a Zustand selector: a fresh
 * array every call loops React 19. `useEntriesForProject` filters in `useMemo`.
 *
 * The panel has to filter: `loadMemory` runs in an effect, so a switch paints
 * once with the previous project's rows still in the store.
 */
export function entriesForProject(entries: MemoryEntry[], projectId: string): MemoryEntry[] {
  return entries.filter((entry) => entry.projectId === projectId);
}

/**
 * Path agents read for this project. Empty when the store still names another
 * project (or none yet), so the footer cannot flash the last folder.
 */
export function memoryFilePathFor(
  filePath: string,
  loadedProjectId: string | null,
  projectId: string,
): string {
  return loadedProjectId === projectId ? filePath : "";
}

/** Filtered list for render. Selects `entries` (stable until replaced) and filters in `useMemo`. */
export function useEntriesForProject(projectId: string): MemoryEntry[] {
  const entries = useMemoryStore((state) => state.entries);
  return useMemo(() => entriesForProject(entries, projectId), [entries, projectId]);
}

/**
 * How much of the memory's budget is spent, for the panel to show before it bites.
 *
 * Counted in code points to agree with the backend, which is what actually enforces
 * the cap. `.length` counts UTF-16 units, so an emoji or an astral character would
 * have made this read high and the warning arrive early.
 */
export function memorySize(entries: MemoryEntry[]): number {
  return entries.reduce((total, entry) => total + [...entry.content].length, 0);
}
