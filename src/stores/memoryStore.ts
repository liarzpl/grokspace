import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import type { MemoryEntry, MemoryEntryType, SkillStatus } from "../types";

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

interface MemoryState {
  entries: MemoryEntry[];
  /** The file agents are told to read, named so a missing one stays discoverable. */
  filePath: string;
  isLoading: boolean;
  skill: SkillStatus | null;
  isInstallingSkill: boolean;
  error: string | null;

  loadMemory: (projectId: string) => Promise<void>;
  /** Writes an entry, replacing whatever was under that key. */
  putEntry: (
    projectId: string,
    entry: { key: string; content: string; type: MemoryEntryType },
  ) => Promise<boolean>;
  forgetEntry: (projectId: string, key: string) => Promise<void>;
  loadSkill: () => Promise<void>;
  installSkill: () => Promise<void>;
  clearError: () => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  entries: [],
  filePath: "",
  isLoading: false,
  skill: null,
  isInstallingSkill: false,
  error: null,

  clearError: () => set({ error: null }),

  loadMemory: async (projectId) => {
    const generation = ++loadGeneration;
    set({ isLoading: true, error: null });
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

  putEntry: async (projectId, entry) => {
    try {
      set({ entries: await api.putMemory(projectId, entry), error: null });
      return true;
    } catch (error) {
      // Reported rather than swallowed: the cap and the empty-key rule both land
      // here, and both are things someone needs told.
      set({ error: errorMessage(error) });
      return false;
    }
  },

  forgetEntry: async (projectId, key) => {
    try {
      set({ entries: await api.removeMemory(projectId, key) });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  loadSkill: async () => {
    if (get().skill !== null) return;
    try {
      set({ skill: await api.memorySkillStatus() });
    } catch {
      // Only decides whether to offer the install; a failure here should not put an
      // error over a panel that is otherwise working.
    }
  },

  installSkill: async () => {
    set({ isInstallingSkill: true, error: null });
    try {
      set({ skill: await api.installMemorySkill() });
    } catch (error) {
      set({ error: errorMessage(error) });
    } finally {
      set({ isInstallingSkill: false });
    }
  },
}));

/** The entries of one type, in the order the backend returned them. */
export function entriesOfType(entries: MemoryEntry[], type: MemoryEntryType): MemoryEntry[] {
  return entries.filter((entry) => entry.type === type);
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
