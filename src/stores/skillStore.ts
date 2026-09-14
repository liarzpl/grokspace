import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import type { UserSkillRecord } from "../lib/skillProvenance";
import type { SkillStatus } from "../types";

export const SKILL_IDS = ["graph", "memory", "steps"] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export interface SkillSlot {
  status: SkillStatus | null;
  isInstalling: boolean;
  error: string | null;
}

const EMPTY: SkillSlot = { status: null, isInstalling: false, error: null };

function emptySlots(): Record<SkillId, SkillSlot> {
  return { graph: { ...EMPTY }, memory: { ...EMPTY }, steps: { ...EMPTY } };
}

interface SkillStoreState {
  byId: Record<SkillId, SkillSlot>;
  load: (id: SkillId) => Promise<void>;
  /** Re-reads disk even when a status is already cached. */
  refresh: (id: SkillId) => Promise<void>;
  refreshAll: () => Promise<void>;
  install: (id: SkillId) => Promise<void>;
  /** Writes `~/.grokspace/skills/<name>/SKILL.md`. Does not install into grok. */
  saveUserSkill: (name: string, markdown: string) => Promise<UserSkillRecord>;
  setError: (id: SkillId, error: string) => void;
  clearError: (id?: SkillId) => void;
}

function write(
  set: (updater: (state: SkillStoreState) => Partial<SkillStoreState>) => void,
  id: SkillId,
  changes: Partial<SkillSlot>,
): void {
  set((state) => ({
    byId: { ...state.byId, [id]: { ...state.byId[id], ...changes } },
  }));
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  byId: emptySlots(),

  load: async (id) => {
    if (get().byId[id].status !== null) return;
    await get().refresh(id);
  },

  refresh: async (id) => {
    try {
      write(set, id, { status: await api.skillStatus(id) });
    } catch {
      // Only decides whether to offer the install; a failure here should not
      // put an error over a panel that is otherwise working.
    }
  },

  refreshAll: async () => {
    for (const id of SKILL_IDS) {
      await get().refresh(id);
    }
  },

  install: async (id) => {
    write(set, id, { isInstalling: true, error: null });
    try {
      write(set, id, { status: await api.installSkill(id) });
    } catch (error) {
      write(set, id, { error: errorMessage(error) });
    } finally {
      write(set, id, { isInstalling: false });
    }
  },

  saveUserSkill: (name, markdown) => api.saveUserSkill({ name, markdown }),

  setError: (id, error) => write(set, id, { error }),

  clearError: (id) => {
    if (id !== undefined) {
      write(set, id, { error: null });
      return;
    }
    set((state) => ({
      byId: {
        graph: { ...state.byId.graph, error: null },
        memory: { ...state.byId.memory, error: null },
        steps: { ...state.byId.steps, error: null },
      },
    }));
  },
}));

export function skillOf(byId: Record<SkillId, SkillSlot>, id: SkillId): SkillSlot {
  return byId[id];
}

/** First skill error, for the single banner App already owns. */
export function firstSkillError(byId: Record<SkillId, SkillSlot>): string | null {
  for (const id of SKILL_IDS) {
    const error = byId[id].error;
    if (error !== null) return error;
  }
  return null;
}

/**
 * Palette wording for one bundled skill. Installed vs missing only — there is
 * no remote catalog, and a slot that has not been read yet keeps the older
 * "install or refresh" line rather than guessing.
 */
export function skillCommandLabel(id: SkillId, slot: SkillSlot): string {
  if (slot.status == null) return `Install or refresh the ${id} skill`;
  return slot.status.installed
    ? `Refresh the ${id} skill (installed)`
    : `Install the ${id} skill (missing)`;
}
