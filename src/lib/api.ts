import { invoke, type Channel } from "@tauri-apps/api/core";

import type {
  GraphSnapshot,
  Project,
  ProjectSettings,
  Session,
  SessionKind,
  SkillStatus,
} from "../types";

/**
 * Typed wrappers around the Tauri commands, so components never spell out raw
 * command names or argument shapes.
 */
export const api = {
  listProjects: (): Promise<Project[]> => invoke<Project[]>("list_projects"),

  /** Registers a folder as a project, or refreshes it if already known. */
  openProject: (path: string): Promise<Project> => invoke<Project>("open_project", { path }),

  updateProject: (
    id: string,
    changes: { name?: string; settings?: ProjectSettings },
  ): Promise<Project> =>
    invoke<Project>("update_project", {
      id,
      name: changes.name ?? null,
      settings: changes.settings ?? null,
    }),

  touchProject: (id: string): Promise<Project> => invoke<Project>("touch_project", { id }),

  /** Forgets the project. Nothing on disk is deleted. */
  removeProject: (id: string): Promise<void> => invoke<void>("remove_project", { id }),

  listSessions: (projectId: string): Promise<Session[]> =>
    invoke<Session[]>("list_sessions", { projectId }),

  createSession: (input: {
    projectId: string;
    paneId: string;
    kind: SessionKind;
    cols: number;
    rows: number;
  }): Promise<Session> => invoke<Session>("create_session", input),

  /** Routes the session's output into `onOutput`, replaying buffered scrollback. */
  attachSession: (id: string, onOutput: Channel<ArrayBuffer>): Promise<void> =>
    invoke<void>("attach_session", { id, onOutput }),

  writeSession: (id: string, data: string): Promise<void> =>
    invoke<void>("write_session", { id, data }),

  resizeSession: (id: string, cols: number, rows: number): Promise<void> =>
    invoke<void>("resize_session", { id, cols, rows }),

  stopSession: (id: string): Promise<void> => invoke<void>("stop_session", { id }),

  /** Starts a replacement session in the same pane and returns it. */
  restartSession: (id: string, cols: number, rows: number): Promise<Session> =>
    invoke<Session>("restart_session", { id, cols, rows }),

  renameSession: (id: string, title: string): Promise<Session> =>
    invoke<Session>("rename_session", { id, title }),

  /** Ends the session and frees its pane. */
  closeSession: (id: string): Promise<void> => invoke<void>("close_session", { id }),

  /** Reads the graph file belonging to one session, whether or not it exists. */
  readSessionGraph: (sessionId: string): Promise<GraphSnapshot> =>
    invoke<GraphSnapshot>("read_session_graph", { sessionId }),

  /** Watches the project's graph directories; returns the ones being watched. */
  watchProjectGraphs: (projectId: string): Promise<string[]> =>
    invoke<string[]>("watch_project_graphs", { projectId }),

  unwatchProjectGraphs: (projectId: string): Promise<void> =>
    invoke<void>("unwatch_project_graphs", { projectId }),

  graphSkillStatus: (): Promise<SkillStatus> => invoke<SkillStatus>("graph_skill_status"),

  /** Installs, or refreshes, the skill that teaches `grok` to write graphs. */
  installGraphSkill: (): Promise<SkillStatus> => invoke<SkillStatus>("install_graph_skill"),
};

/** Rust returns errors as plain strings, so unwrap them for display. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
