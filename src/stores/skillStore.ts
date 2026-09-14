import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
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
  install: (id: SkillId) => Promise<void>;
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
    try {
      write(set, id, { status: await api.skillStatus(id) });
    } catch {
      // Only decides whether to offer the install; a failure here should not
      // put an error over a panel that is otherwise working.
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
