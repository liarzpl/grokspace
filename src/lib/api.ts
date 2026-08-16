import { invoke } from "@tauri-apps/api/core";

import type { Project, ProjectSettings } from "../types";

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
};

/** Rust returns errors as plain strings, so unwrap them for display. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
