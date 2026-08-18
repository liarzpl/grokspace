import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import type { SessionStatus, Task, TaskStatus } from "../types";
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

/** Drops in-flight `loadTasks` results that a newer project switch has replaced. */
let loadGeneration = 0;

/**
 * Whether a session in this state can be given work.
 *
 * A terminal only ever reports `running`. An agent reports more, and `idle` is the
 * state it is most ready in — it means the last turn finished. `needs_input` is
 * refused: it is already blocked, and a second prompt would queue behind a question
 * nobody has answered.
 */
function canTake(status: SessionStatus): boolean {
  return status === "running" || status === "idle";
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
  /**
   * Starts something to do the work and sends the task to it. A `paneId` starts a
   * Grok terminal in that pane; omitting one starts an ACP agent, which needs no
   * pane and can report what it is doing.
   */
  dispatchToNewSession: (
    taskId: string,
    projectId: string,
    paneId: string | null,
  ) => Promise<boolean>;
  clearError: () => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  isLoading: false,
  dispatching: {},
  error: null,

  clearError: () => set({ error: null }),

  loadTasks: async (projectId) => {
    const generation = ++loadGeneration;
    set({ isLoading: true, error: null });
    try {
      const tasks = await api.listTasks(projectId);
      if (generation !== loadGeneration) return;
      set({ tasks, isLoading: false });
    } catch (error) {
      if (generation !== loadGeneration) return;
      set({ error: errorMessage(error), isLoading: false, tasks: [] });
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

    // A shell is refused outright: it would try to *run* the prompt, and "Fix the
    // login bug" is a command as far as bash is concerned, which is worse than
    // refusing. A stopped session of either kind would swallow it.
    if (!session || session.kind === "shell" || !canTake(session.status)) {
      set({ error: "That session is not running an agent to hand the task to." });
      return false;
    }

    set((state) => ({ dispatching: { ...state.dispatching, [taskId]: true }, error: null }));
    let assigned = false;
    try {
      // The assignment is recorded first so the board agrees with the session
      // that is about to receive the work. The prompt comes second; if it fails
      // the assignment is unwound so the card does not claim a hand-off that
      // never landed.
      const dispatched = await api.dispatchTask(taskId, sessionId);
      assigned = true;
      set((state) => ({ tasks: replaceTask(state.tasks, dispatched) }));
      if (session.kind === "agent") await api.promptSession(sessionId, dispatchPrompt(task));
      else await api.writeSession(sessionId, `${dispatchPrompt(task)}\r`);
      return true;
    } catch (error) {
      if (assigned) {
        try {
          const undone = await api.undispatchTask(taskId);
          set((state) => ({ tasks: replaceTask(state.tasks, undone) }));
        } catch {
          // The prompt is still the failure to show.
        }
      }
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
      kind: paneId === null ? "agent" : "grok",
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
