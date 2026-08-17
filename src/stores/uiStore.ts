import { create } from "zustand";

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

/** The panels the workspace switches between while working. */
export type WorkspaceTab = "terminals" | "graph" | "tasks" | "memory";

export const TABS: readonly { id: WorkspaceTab; label: string }[] = [
  { id: "terminals", label: "Terminals" },
  { id: "graph", label: "Graph" },
  { id: "tasks", label: "Tasks" },
  { id: "memory", label: "Memory" },
];

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
  tab: "terminals",
  isSettingsOpen: false,
  isPaletteOpen: false,

  // Closing the palette on its way out of every command, so a command that changes
  // the tab does not leave the palette sitting over the thing it just revealed.
  setTab: (tab) => set({ tab, isPaletteOpen: false }),
  openSettings: () => set({ isSettingsOpen: true, isPaletteOpen: false }),
  closeSettings: () => set({ isSettingsOpen: false }),
  togglePalette: () => set((state) => ({ isPaletteOpen: !state.isPaletteOpen })),
  closePalette: () => set({ isPaletteOpen: false }),
}));
