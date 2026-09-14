import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import {
  PANE_LAYOUTS,
  type FolderTrust,
  type FolderTrustDecision,
  type PaneLayout,
  type Project,
} from "../types";
import { useSessionStore } from "./sessionStore";
import { useSettingsStore } from "./settingsStore";

/** Matches the backend ordering: most recently opened first. */
function sortByRecency(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    const recency = (b.lastOpened ?? b.createdAt) - (a.lastOpened ?? a.createdAt);
    return recency !== 0 ? recency : a.name.localeCompare(b.name);
  });
}

function replaceProject(projects: Project[], updated: Project): Project[] {
  const without = projects.filter((project) => project.id !== updated.id);
  return sortByRecency([...without, updated]);
}

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  isLoading: boolean;
  isOpening: boolean;
  error: string | null;
  folderTrust: Record<string, FolderTrust>;

  loadProjects: () => Promise<void>;
  pickAndOpenProject: () => Promise<Project | null>;
  selectProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  setLayout: (id: string, layout: PaneLayout) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  /** @deprecated Use `removeProject`. Alias for one release. */
  forgetProject: (id: string) => Promise<void>;
  loadFolderTrust: (id: string) => Promise<void>;
  setFolderTrust: (id: string, decision: FolderTrustDecision) => Promise<void>;
  clearError: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  isLoading: false,
  isOpening: false,
  error: null,
  folderTrust: {},

  clearError: () => set({ error: null }),

  loadProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const projects = sortByRecency(await api.listProjects());
      set((state) => ({
        projects,
        // Land on the most recent project rather than an empty workspace, but
        // never override a selection the user already made.
        activeProjectId:
          state.activeProjectId && projects.some((p) => p.id === state.activeProjectId)
            ? state.activeProjectId
            : (projects[0]?.id ?? null),
        isLoading: false,
      }));
    } catch (error) {
      set({ error: errorMessage(error), isLoading: false });
    }
  },

  pickAndOpenProject: async () => {
    set({ isOpening: true, error: null });
    try {
      const project = await api.openProject();
      if (!project) {
        set({ isOpening: false });
        return null;
      }
      set((state) => ({
        projects: replaceProject(state.projects, project),
        activeProjectId: project.id,
        isOpening: false,
      }));
      return project;
    } catch (error) {
      set({ error: errorMessage(error), isOpening: false });
      return null;
    }
  },

  selectProject: async (id) => {
    set({ activeProjectId: id, error: null });
    try {
      const project = await api.touchProject(id);
      set((state) => ({ projects: replaceProject(state.projects, project) }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  renameProject: async (id, name) => {
    try {
      const project = await api.updateProject(id, { name });
      set((state) => ({ projects: replaceProject(state.projects, project) }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  /** The pane layout is per-project, so it rides along in the settings blob. */
  setLayout: async (id, layout) => {
    const project = get().projects.find((existing) => existing.id === id);
    if (!project) return;
    try {
      const updated = await api.updateProject(id, {
        settings: { ...project.settings, terminalLayout: layout },
      });
      set((state) => ({ projects: replaceProject(state.projects, updated) }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  removeProject: async (id) => {
    try {
      // Listed first so the frontend can dispose terminals even if this project
      // is not the one currently on screen. The backend then kills the children.
      const sessions = await api.listSessions(id);
      const { disposeTerminal } = await import("../lib/terminals");
      for (const session of sessions) {
        disposeTerminal(session.id);
      }
      await api.removeProject(id);
      useSessionStore
        .getState()
        .forgetSessions(
          sessions.map((session) => session.id),
          get().activeProjectId === id,
        );
      set((state) => {
        const projects = state.projects.filter((project) => project.id !== id);
        const folderTrust = { ...state.folderTrust };
        delete folderTrust[id];
        return {
          projects,
          folderTrust,
          activeProjectId:
            state.activeProjectId === id ? (projects[0]?.id ?? null) : state.activeProjectId,
        };
      });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  forgetProject: (id) => get().removeProject(id),

  loadFolderTrust: async (id) => {
    try {
      const decision = await api.projectTrust(id);
      set((state) => ({ folderTrust: { ...state.folderTrust, [id]: decision } }));
    } catch (error) {
      set((state) => ({
        error: errorMessage(error),
        folderTrust: { ...state.folderTrust, [id]: "unknown" },
      }));
    }
  },

  setFolderTrust: async (id, decision) => {
    try {
      const next = await api.setProjectTrust(id, decision);
      set((state) => ({ folderTrust: { ...state.folderTrust, [id]: next } }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },
}));

/**
 * A project's layout, or the configured default for one that has never chosen.
 *
 * The fallback is read from the settings store rather than threaded through every
 * caller: `layoutOf` is called from four places that have no business knowing about
 * preferences, and passing it down would have been four signatures changed to move
 * one value.
 */
export function layoutOf(project: Project | null, fallback?: PaneLayout): PaneLayout {
  const stored = project?.settings.terminalLayout;
  if (stored !== undefined && (PANE_LAYOUTS as readonly string[]).includes(stored)) {
    return stored;
  }
  return fallback ?? useSettingsStore.getState().settings.defaultLayout;
}

export function useActiveProject(): Project | null {
  return useProjectStore(
    (state) => state.projects.find((project) => project.id === state.activeProjectId) ?? null,
  );
}
