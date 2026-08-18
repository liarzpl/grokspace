import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import { disposeTerminal } from "../lib/terminals";
import { PANE_LAYOUTS, type PaneLayout, type Project } from "../types";
import { useGraphStore } from "./graphStore";
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

  loadProjects: () => Promise<void>;
  pickAndOpenProject: () => Promise<Project | null>;
  openProjectAtPath: (path: string) => Promise<Project | null>;
  selectProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  setLayout: (id: string, layout: PaneLayout) => Promise<void>;
  forgetProject: (id: string) => Promise<void>;
  clearError: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  isLoading: false,
  isOpening: false,
  error: null,

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
    const selected = await openFolderDialog({
      directory: true,
      multiple: false,
      title: "Open a project folder",
    });
    if (typeof selected !== "string") return null;
    return get().openProjectAtPath(selected);
  },

  openProjectAtPath: async (path) => {
    set({ isOpening: true, error: null });
    try {
      const project = await api.openProject(path);
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

  forgetProject: async (id) => {
    try {
      // Listed first so the frontend can dispose terminals even if this project
      // is not the one currently on screen. The backend then kills the children.
      const sessions = await api.listSessions(id);
      for (const session of sessions) {
        disposeTerminal(session.id);
        useGraphStore.getState().forget(session.id);
      }
      await api.removeProject(id);
      const forgotten = new Set(sessions.map((session) => session.id));
      useSessionStore.setState((state) => ({
        transcript: Object.fromEntries(
          Object.entries(state.transcript).filter(([sessionId]) => !forgotten.has(sessionId)),
        ),
        ...(get().activeProjectId === id
          ? { sessions: [], permissions: {}, paneViews: {}, maximizedPane: null }
          : {}),
      }));
      set((state) => {
        const projects = state.projects.filter((project) => project.id !== id);
        return {
          projects,
          activeProjectId:
            state.activeProjectId === id ? (projects[0]?.id ?? null) : state.activeProjectId,
        };
      });
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
  const stored = project?.settings["terminalLayout"];
  if (typeof stored === "string" && (PANE_LAYOUTS as readonly string[]).includes(stored)) {
    return stored as PaneLayout;
  }
  return fallback ?? useSettingsStore.getState().settings.defaultLayout;
}

export function useActiveProject(): Project | null {
  return useProjectStore(
    (state) => state.projects.find((project) => project.id === state.activeProjectId) ?? null,
  );
}
