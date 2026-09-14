import { create } from "zustand";

import { DEFAULT_TAB, WORKSPACE_TABS, type WorkspaceTab } from "../types";

/**
 * The bits of interface state that more than one component needs.
 *
 * The workspace tab used to be `useState` inside `WorkspaceShell`, which was right
 * while it was the only thing that switched it. The command palette can switch it
 * too, and two components cannot share a `useState`.
 *
 * Deliberately small. Pane views, which pane is maximised, and which graph is
 * selected all stay where they are: nothing outside their own component asks.
 */

export type { WorkspaceTab };

const TAB_LABELS: Record<WorkspaceTab, string> = {
  terminals: "Terminals",
  graph: "Graph",
  tasks: "Tasks",
  memory: "Memory",
  diff: "Diff",
};

/** Labels over the shared tab list; the ids themselves live on `WorkspaceTab`. */
export const TABS: readonly { id: WorkspaceTab; label: string }[] = WORKSPACE_TABS.map((id) => ({
  id,
  label: TAB_LABELS[id],
}));

interface UiState {
  tab: WorkspaceTab;
  /**
   * Settings is an overlay rather than a tab. Tabs are the things you move between
   * while working, and settings is not one of them — six tabs would have made the
   * row a menu.
   */
  isSettingsOpen: boolean;
  isPaletteOpen: boolean;

  setTab: (tab: WorkspaceTab) => void;
  openSettings: () => void;
  closeSettings: () => void;
  /** Toggling rather than opening, so the same key closes it. */
  togglePalette: () => void;
  closePalette: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  tab: DEFAULT_TAB,
  isSettingsOpen: false,
  isPaletteOpen: false,

  // Closing the palette on its way out of every command, so a command that changes
  // the tab does not leave the palette sitting over the thing it just revealed.
  setTab: (tab) => set({ tab, isPaletteOpen: false }),
  openSettings: () => set({ isSettingsOpen: true, isPaletteOpen: false }),
  closeSettings: () => set({ isSettingsOpen: false }),
  togglePalette: () =>
    set((state) => {
      const isPaletteOpen = !state.isPaletteOpen;
      // Settings and the palette share a z-index. Opening one on top of the other
      // would leave both claiming the screen; closing settings here is the same
      // courtesy openSettings already pays the palette.
      return {
        isPaletteOpen,
        isSettingsOpen: isPaletteOpen ? false : state.isSettingsOpen,
      };
    }),
  closePalette: () => set({ isPaletteOpen: false }),
}));
