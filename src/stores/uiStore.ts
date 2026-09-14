import { create } from "zustand";

import { foldUpdate } from "../lib/transcript";
import {
  DEFAULT_TAB,
  WORKSPACE_TABS,
  type AgentUpdate,
  type PermissionRequest,
  type WorkspaceTab,
} from "../types";

/**
 * The bits of interface state that more than one component needs.
 *
 * The workspace tab used to be `useState` inside `WorkspaceShell`, which was right
 * while it was the only thing that switched it. The command palette can switch it
 * too, and two components cannot share a `useState`.
 *
 * Pane faces, the Graph-tab selection, transcripts, pending permission chips,
 * and inbox snooze-until timestamps live here with the tab: they are chrome,
 * not process state. The session store keeps the live sessions themselves and
 * writes the permission and transcript maps as they change.
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

/** A copy without one session's entry. */
function without<T>(bySession: Record<string, T>, id: string): Record<string, T> {
  if (!(id in bySession)) return bySession;
  const next = { ...bySession };
  delete next[id];
  return next;
}

/** Drops keys that are not in `ids`. */
function keepOnly<T>(bySession: Record<string, T>, ids: ReadonlySet<string>): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [id, value] of Object.entries(bySession)) {
    if (ids.has(id)) next[id] = value;
  }
  return next;
}

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
  /**
   * Which session the Graph tab is showing. Chrome, not a session field:
   * the palette and inbox keys need this without sharing WorkspaceShell state.
   */
  graphSessionId: string | null;
  /**
   * What each agent is blocked on, keyed by session. Only ACP sessions ever have
   * any: a terminal has no way to ask.
   */
  permissions: Record<string, PermissionRequest[]>;
  /**
   * Visible ACP output, keyed by session. Survives a project switch so coming
   * back does not blank a conversation that is still running.
   */
  transcript: Record<string, AgentUpdate[]>;
  /**
   * Inbox waits hidden until this unix-ms. The agent still holds
   * `needs_input`; we never answer ACP from here.
   */
  snoozedUntil: Record<string, number>;

  setTab: (tab: WorkspaceTab) => void;
  setPaneView: (paneId: string, view: PaneView) => void;
  toggleMaximized: (paneId: string) => void;
  selectGraph: (sessionId: string) => void;
  replacePermissions: (permissions: Record<string, PermissionRequest[]>) => void;
  upsertPermission: (id: string, request: PermissionRequest) => void;
  dropPermissionRequest: (id: string, requestId: number) => void;
  dropSessionPermissions: (id: string) => void;
  appendTranscript: (id: string, update: AgentUpdate) => void;
  keepTranscript: (ids: ReadonlySet<string>) => void;
  dropTranscript: (id: string) => void;
  forgetTranscript: (ids: ReadonlySet<string>) => void;
  setSnooze: (id: string, until: number) => void;
  replaceSnooze: (snoozedUntil: Record<string, number>) => void;
  dropExpiredSnooze: (now: number) => void;
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
  graphSessionId: null,
  permissions: {},
  transcript: {},
  snoozedUntil: {},

  // Closing the palette on its way out of every command, so a command that changes
  // the tab does not leave the palette sitting over the thing it just revealed.
  setTab: (tab) => set({ tab, isPaletteOpen: false }),
  setPaneView: (paneId, view) =>
    set((state) => ({ paneViews: { ...state.paneViews, [paneId]: view } })),
  toggleMaximized: (paneId) =>
    set((state) => ({ maximizedPane: state.maximizedPane === paneId ? null : paneId })),
  selectGraph: (sessionId) => set({ graphSessionId: sessionId }),
  replacePermissions: (permissions) => set({ permissions }),
  upsertPermission: (id, request) =>
    set((state) => {
      const existing = state.permissions[id] ?? [];
      const index = existing.findIndex((item) => item.requestId === request.requestId);
      const next =
        index === -1
          ? [...existing, request]
          : existing.map((item, i) => (i === index ? request : item));
      return { permissions: { ...state.permissions, [id]: next } };
    }),
  dropPermissionRequest: (id, requestId) =>
    set((state) => ({
      permissions: {
        ...state.permissions,
        [id]: (state.permissions[id] ?? []).filter((request) => request.requestId !== requestId),
      },
    })),
  dropSessionPermissions: (id) =>
    set((state) => ({ permissions: without(state.permissions, id) })),
  appendTranscript: (id, update) =>
    set((state) => ({
      transcript: { ...state.transcript, [id]: foldUpdate(state.transcript[id] ?? [], update) },
    })),
  keepTranscript: (ids) => set((state) => ({ transcript: keepOnly(state.transcript, ids) })),
  dropTranscript: (id) => set((state) => ({ transcript: without(state.transcript, id) })),
  forgetTranscript: (ids) =>
    set((state) => ({
      transcript: Object.fromEntries(
        Object.entries(state.transcript).filter(([sessionId]) => !ids.has(sessionId)),
      ),
    })),
  setSnooze: (id, until) =>
    set((state) => ({ snoozedUntil: { ...state.snoozedUntil, [id]: until } })),
  replaceSnooze: (snoozedUntil) => set({ snoozedUntil }),
  dropExpiredSnooze: (now) =>
    set((state) => {
      const snoozedUntil: Record<string, number> = {};
      for (const [id, until] of Object.entries(state.snoozedUntil)) {
        if (until > now) snoozedUntil[id] = until;
      }
      if (Object.keys(snoozedUntil).length === Object.keys(state.snoozedUntil).length) {
        return state;
      }
      return { snoozedUntil };
    }),
  resetPaneChrome: () => set({ paneViews: {}, maximizedPane: null, graphSessionId: null }),
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
