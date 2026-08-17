import { invoke, type Channel } from "@tauri-apps/api/core";

import type {
  GraphSnapshot,
  MemoryEntry,
  MemoryEntryType,
  Project,
  ProjectSettings,
  Session,
  SessionKind,
  SkillStatus,
  Task,
  TaskStatus,
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

  /** `paneId` is absent for an `agent`, which runs beside the grid rather than in it. */
  createSession: (input: {
    projectId: string;
    paneId: string | null;
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

  /**
   * Sends a prompt to an `agent` session. `writeSession` is the terminal
   * equivalent and cannot know whether anything read what it typed; this is a
   * request, and the agent's reply is what returns the session to `idle`.
   */
  promptSession: (id: string, text: string): Promise<void> =>
    invoke<void>("prompt_session", { id, text }),

  /** Answers what an agent is blocked on, which is what lets it carry on. */
  answerSessionPermission: (id: string, requestId: number, allow: boolean): Promise<void> =>
    invoke<void>("answer_session_permission", { id, requestId, allow }),

  listTasks: (projectId: string): Promise<Task[]> => invoke<Task[]>("list_tasks", { projectId }),

  /** Adds a task to the project's backlog. */
  createTask: (input: {
    projectId: string;
    title: string;
    description?: string;
  }): Promise<Task> =>
    invoke<Task>("create_task", {
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? null,
    }),

  updateTask: (
    id: string,
    changes: {
      title?: string;
      description?: string;
      status?: TaskStatus;
      priority?: number;
    },
  ): Promise<Task> =>
    invoke<Task>("update_task", {
      id,
      title: changes.title ?? null,
      description: changes.description ?? null,
      status: changes.status ?? null,
      priority: changes.priority ?? null,
    }),

  /** Hands the task to a session and moves it to `in_progress` together. */
  dispatchTask: (id: string, sessionId: string): Promise<Task> =>
    invoke<Task>("dispatch_task", { id, sessionId }),

  removeTask: (id: string): Promise<void> => invoke<void>("remove_task", { id }),

  listMemory: (projectId: string): Promise<MemoryEntry[]> =>
    invoke<MemoryEntry[]>("list_memory", { projectId }),

  /**
   * Writes one entry and returns the whole memory, since the file agents read is
   * rebuilt from all of it and the panel wants the list it was built from.
   *
   * `type` is `entryType` across the boundary because `type` is a Rust keyword; the
   * entry itself still carries it as `type`.
   */
  putMemory: (
    projectId: string,
    entry: { key: string; content: string; type: MemoryEntryType },
  ): Promise<MemoryEntry[]> =>
    invoke<MemoryEntry[]>("put_memory", {
      projectId,
      key: entry.key,
      content: entry.content,
      entryType: entry.type,
    }),

  removeMemory: (projectId: string, key: string): Promise<MemoryEntry[]> =>
    invoke<MemoryEntry[]>("remove_memory", { projectId, key }),

  /** The file the project's agents are told to read, for the panel to name. */
  memoryFilePath: (projectId: string): Promise<string> =>
    invoke<string>("memory_file_path", { projectId }),

  memorySkillStatus: (): Promise<SkillStatus> => invoke<SkillStatus>("memory_skill_status"),

  /** Installs, or refreshes, the skill that teaches `grok` to read the memory. */
  installMemorySkill: (): Promise<SkillStatus> => invoke<SkillStatus>("install_memory_skill"),

  /** Reads the graph file belonging to one session, whether or not it exists. */
  readSessionGraph: (sessionId: string): Promise<GraphSnapshot> =>
    invoke<GraphSnapshot>("read_session_graph", { sessionId }),

  /**
   * Watches the directory the project's sessions write their graphs into so changes
   * are reported, and returns what is being watched. Asking twice is harmless.
   */
  watchProjectGraphs: (projectId: string): Promise<string[]> =>
    invoke<string[]>("watch_project_graphs", { projectId }),

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
