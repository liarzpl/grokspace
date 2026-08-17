import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import type { Task, TaskStatus } from "../types";
import { useSessionStore } from "./sessionStore";

/**
 * The task board, and the one action that reaches outside it.
 *
 * Dispatching is the reason this store knows about sessions at all: a task is
 * handed to an agent by typing it into that agent's terminal, the same way the
 * graph panel's "Ask for a graph" does. The dependency runs one way only —
 * `sessionStore` must not learn about tasks — because it already owns the xterm
 * registry, and pulling that into this store's tests would drag a terminal
 * emulator into testing a Kanban column.
 */

/** A session started for a task has not been measured yet, so it starts classic. */
const FALLBACK_SIZE = { cols: 80, rows: 24 };

/**
 * What a dispatched task types into the agent's terminal.
 *
 * One line, because a newline submits in a TUI: a description spread over several
 * lines would arrive as several prompts, most of them fragments. The description
 * rides along after the title since a task worth describing is usually one whose
 * description is the point.
 */
export function dispatchPrompt(task: Task): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const goal = oneLine(task.title);
  const context = task.description === null ? "" : oneLine(task.description);
  return context === "" ? goal : `${goal} — ${context}`;
}

/** Newest tasks last within a column, matching the backend's ordering. */
function replaceTask(tasks: Task[], next: Task): Task[] {
  return tasks.map((task) => (task.id === next.id ? next : task));
}

interface TaskState {
  tasks: Task[];
  isLoading: boolean;
  /** Tasks with a dispatch in flight, so a card can show it is going somewhere. */
  dispatching: Record<string, boolean>;
  error: string | null;

  loadTasks: (projectId: string) => Promise<void>;
  createTask: (projectId: string, title: string, description?: string) => Promise<Task | null>;
  editTask: (id: string, changes: { title?: string; description?: string }) => Promise<void>;
  /** Drag between columns, and the only way a task's status changes by hand. */
  moveTask: (id: string, status: TaskStatus) => Promise<void>;
  removeTask: (id: string) => Promise<void>;
  /** Sends a task to a session that is already running an agent. */
  dispatch: (taskId: string, sessionId: string) => Promise<boolean>;
  /** Starts an agent in a free pane and sends the task to it. */
  dispatchToNewSession: (taskId: string, projectId: string, paneId: string) => Promise<boolean>;
  clearError: () => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  isLoading: false,
  dispatching: {},
  error: null,

  clearError: () => set({ error: null }),

  loadTasks: async (projectId) => {
    set({ isLoading: true, error: null });
    try {
      set({ tasks: await api.listTasks(projectId), isLoading: false });
    } catch (error) {
      set({ error: errorMessage(error), isLoading: false });
    }
  },

  createTask: async (projectId, title, description) => {
    try {
      const task = await api.createTask({ projectId, title, description });
      set((state) => ({ tasks: [...state.tasks, task] }));
      return task;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  editTask: async (id, changes) => {
    try {
      const task = await api.updateTask(id, changes);
      set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  moveTask: async (id, status) => {
    try {
      const task = await api.updateTask(id, { status });
      set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  removeTask: async (id) => {
    try {
      await api.removeTask(id);
      set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  dispatch: async (taskId, sessionId) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) return false;

    const session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId);

    // Only a running agent. A stopped one would swallow the prompt, and a shell
    // would try to *run* it — "Fix the login bug" is a command as far as bash is
    // concerned, which is a worse outcome than refusing.
    if (!session || session.kind !== "grok" || session.status !== "running") {
      set({ error: "That pane is not running an agent to hand the task to." });
      return false;
    }

    set((state) => ({ dispatching: { ...state.dispatching, [taskId]: true }, error: null }));
    try {
      // The prompt goes first: the board should only claim the task was handed
      // over once something has actually received it.
      await api.writeSession(sessionId, `${dispatchPrompt(task)}\r`);
      const dispatched = await api.dispatchTask(taskId, sessionId);
      set((state) => ({ tasks: replaceTask(state.tasks, dispatched) }));
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    } finally {
      set((state) => ({ dispatching: { ...state.dispatching, [taskId]: false } }));
    }
  },

  dispatchToNewSession: async (taskId, projectId, paneId) => {
    const session = await useSessionStore.getState().startSession({
      projectId,
      paneId,
      kind: "grok",
      ...FALLBACK_SIZE,
    });
    // startSession has already put its own failure on the session store's error,
    // which the shell surfaces; repeating it here would show it twice.
    if (!session) return false;
    return get().dispatch(taskId, session.id);
  },
}));

/** The tasks in one column, in the order the backend returned them. */
export function tasksInColumn(tasks: Task[], status: TaskStatus): Task[] {
  return tasks.filter((task) => task.status === status);
}
