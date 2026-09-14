import { create } from "zustand";

import { DEFAULT_TAB, WORKSPACE_TABS, type WorkspaceTab } from "../types";

/**
 * The bits of interface state that more than one component needs.
 *
 * The workspace tab used to be `useState` inside `WorkspaceShell`, which was right
 * while it was the only thing that switched it. The command palette can switch it
 * too, and two components cannot share a `useState`.
 *
 * Pane faces and which pane is maximised live here with the tab: they are chrome,
 * not process state. The session store keeps the live sessions themselves.
 */

export type { WorkspaceTab };

/** A pane shows its terminal, the graph the session is reporting, or its steps. */
export type PaneView = "terminal" | "graph" | "steps";

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
  /** Which of its faces each pane is showing; panes default to terminal. */
  paneViews: Record<string, PaneView>;
  maximizedPane: string | null;

  setTab: (tab: WorkspaceTab) => void;
  setPaneView: (paneId: string, view: PaneView) => void;
  toggleMaximized: (paneId: string) => void;
  /** Project switch and forget drop chrome that is keyed by reused pane ids. */
  resetPaneChrome: () => void;
  /**
   * Applies the saved opening tab once, and only while the workspace is still
   * on the default. A click or palette command that already left Terminals
   * must not be yanked back when settings resolve.
   */
  applyOpeningTab: (tab: WorkspaceTab) => void;
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
  paneViews: {},
  maximizedPane: null,

  // Closing the palette on its way out of every command, so a command that changes
  // the tab does not leave the palette sitting over the thing it just revealed.
  setTab: (tab) => set({ tab, isPaletteOpen: false }),
  setPaneView: (paneId, view) =>
    set((state) => ({ paneViews: { ...state.paneViews, [paneId]: view } })),
  toggleMaximized: (paneId) =>
    set((state) => ({ maximizedPane: state.maximizedPane === paneId ? null : paneId })),
  resetPaneChrome: () => set({ paneViews: {}, maximizedPane: null }),
  applyOpeningTab: (tab) =>
    set((state) => {
      if (state.tab !== "terminals") return state;
      if (!TABS.some((candidate) => candidate.id === tab)) return state;
      if (state.tab === tab) return state;
      return { tab, isPaletteOpen: false };
    }),
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
