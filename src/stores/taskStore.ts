import { useMemo } from "react";
import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import { talkToSession } from "../lib/talkToSession";
import { sessionCanTakeWork } from "../lib/dispatch";
import { inboxItems } from "../lib/inboxItems";
import { FALLBACK_PTY_SIZE } from "../lib/limits";
import type { PermissionRequest, Session, Settings, Task, TaskStatus } from "../types";
import { useSessionStore } from "./sessionStore";
import { useSettingsStore } from "./settingsStore";
import { useStepStore } from "./stepStore";
import { useUiStore } from "./uiStore";

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

/**
 * What a dispatched task types into the agent's terminal.
 *
 * One line, because a newline submits in a TUI: a description spread over several
 * lines would arrive as several prompts, most of them fragments. The description
 * rides along after the title since a task worth describing is usually one whose
 * description is the point. The last sentence is how the agent knows to write a
 * step list and wait: without it, dispatch would skip the gate entirely.
 */
export function dispatchPrompt(task: Task): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const goal = oneLine(task.title);
  const context = task.description === null ? "" : oneLine(task.description);
  const work = context === "" ? goal : `${goal} — ${context}`;
  const gated = /[.!?]$/.test(work) ? work : `${work}.`;
  return `${gated} Write your steps to $GROKSPACE_STEPS_FILE first, then wait.`;
}

/**
 * Phrase that must be typed to hand out a card while the inbox-zero gate is on.
 *
 * Exact after trim: a checkbox or a fuzzy match would be the default-on escape
 * the setting exists to avoid.
 */
export const DISPATCH_ANYWAY = "dispatch anyway";

export function typedDispatchAnyway(value: string): boolean {
  return value.trim() === DISPATCH_ANYWAY;
}

/** How many Needs you items the attention rail would list for this project. */
export function needsYouWaiting(
  sessions: readonly Pick<
    Session,
    "id" | "kind" | "status" | "title" | "worktreePath" | "projectId"
  >[],
  tasks: readonly Pick<Task, "id" | "assignedSessionId" | "projectId">[],
  permissions: Readonly<Record<string, readonly PermissionRequest[] | undefined>>,
  projectId: string,
): number {
  return inboxItems(
    sessions.filter((session) => session.projectId === projectId),
    tasks.filter((task) => task.projectId === projectId),
    permissions,
    {},
  ).filter((item) => item.split === "needs_you").length;
}

/**
 * Why dispatch is paused, or null when the setting is off, the inbox is empty,
 * or the human typed the override.
 */
export function inboxZeroBlockReason(
  gate: Settings["inboxZeroGate"],
  waiting: number,
  anyway: boolean,
): string | null {
  if (gate !== "on" || waiting === 0 || anyway) return null;
  const who = waiting === 1 ? "Needs you is waiting" : `${waiting} Needs you waits`;
  return `${who}. Answer before handing out another card, or type dispatch anyway.`;
}

function refuseInboxZero(projectId: string, tasks: Task[], anyway: boolean): string | null {
  const { sessions } = useSessionStore.getState();
  return inboxZeroBlockReason(
    useSettingsStore.getState().settings.inboxZeroGate,
    needsYouWaiting(sessions, tasks, useUiStore.getState().permissions, projectId),
    anyway,
  );
}

/** Newest tasks last within a column, matching the backend's ordering. */
function replaceTask(tasks: Task[], next: Task): Task[] {
  return tasks.map((task) => (task.id === next.id ? next : task));
}

/** True before the first load (tests, first paint) or while this project is still current. */
function stillThisProject(loaded: string | null, projectId: string): boolean {
  return loaded === null || loaded === projectId;
}

/** Drops in-flight `loadTasks` results that a newer project switch has replaced. */
let loadGeneration = 0;

interface TaskState {
  tasks: Task[];
  /** Project whose board `tasks` belongs to, or null before the first load. */
  projectId: string | null;
  isLoading: boolean;
  /** Tasks with a dispatch in flight, so a card can show it is going somewhere. */
  dispatching: Record<string, boolean>;
  error: string | null;

  loadTasks: (projectId: string) => Promise<void>;
  createTask: (projectId: string, title: string, description?: string) => Promise<Task | null>;
  updateTask: (id: string, changes: { title?: string; description?: string }) => Promise<void>;
  /** @deprecated Use `updateTask`. Alias for one release. */
  editTask: (id: string, changes: { title?: string; description?: string }) => Promise<void>;
  /** Drag between columns, and the only way a task's status changes by hand. */
  moveTask: (id: string, status: TaskStatus) => Promise<void>;
  removeTask: (id: string) => Promise<void>;
  /** Sends a task to a session that is already running an agent. */
  dispatch: (
    taskId: string,
    sessionId: string,
    options?: { anyway?: boolean },
  ) => Promise<boolean>;
  /**
   * Starts something to do the work and sends the task to it. A `paneId` starts a
   * Grok terminal in that pane; omitting one starts an ACP agent, which needs no
   * pane and can report what it is doing.
   */
  dispatchToNewSession: (
    taskId: string,
    projectId: string,
    paneId: string | null,
    options?: { anyway?: boolean },
  ) => Promise<boolean>;
  clearError: () => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  projectId: null,
  isLoading: false,
  dispatching: {},
  error: null,

  clearError: () => set({ error: null }),

  loadTasks: async (projectId) => {
    const generation = ++loadGeneration;
    const leaving = get().tasks;
    // Until this fetch returns, the board would keep the previous project's
    // cards clickable — Delete/move would hit those ids. Drop them now; a
    // same-project reload must not, or the columns go blank for a frame.
    const switching =
      (get().projectId !== null && get().projectId !== projectId) ||
      leaving.some((task) => task.projectId !== projectId);
    set({
      isLoading: true,
      error: null,
      projectId,
      ...(switching ? { tasks: [], dispatching: {} } : {}),
    });
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
      // Null, not the task: NewTaskForm treats a returned task as "clear the draft".
      if (!stillThisProject(get().projectId, projectId)) return null;
      set((state) => ({ tasks: [...state.tasks, task] }));
      return task;
    } catch (error) {
      if (stillThisProject(get().projectId, projectId)) {
        set({ error: errorMessage(error) });
      }
      return null;
    }
  },

  updateTask: async (id, changes) => {
    const origin = get().tasks.find((task) => task.id === id)?.projectId ?? get().projectId;
    try {
      const task = await api.updateTask(id, changes);
      if (origin !== null && !stillThisProject(get().projectId, origin)) return;
      set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    } catch (error) {
      if (origin !== null && !stillThisProject(get().projectId, origin)) return;
      set({ error: errorMessage(error) });
    }
  },

  moveTask: async (id, status) => {
    const origin = get().tasks.find((task) => task.id === id)?.projectId ?? get().projectId;
    try {
      const task = await api.updateTask(id, { status });
      if (origin !== null && !stillThisProject(get().projectId, origin)) return;
      set((state) => ({ tasks: replaceTask(state.tasks, task) }));
    } catch (error) {
      if (origin !== null && !stillThisProject(get().projectId, origin)) return;
      set({ error: errorMessage(error) });
    }
  },

  removeTask: async (id) => {
    const origin = get().tasks.find((task) => task.id === id)?.projectId ?? get().projectId;
    try {
      await api.removeTask(id);
      if (origin !== null && !stillThisProject(get().projectId, origin)) return;
      set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));
    } catch (error) {
      if (origin !== null && !stillThisProject(get().projectId, origin)) return;
      set({ error: errorMessage(error) });
    }
  },

  dispatch: async (taskId, sessionId, options) => {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) return false;
    const origin = task.projectId;
    const blocked = refuseInboxZero(origin, get().tasks, options?.anyway === true);
    if (blocked !== null) {
      set({ error: blocked });
      return false;
    }

    const session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId);

    // A shell is refused outright: it would try to *run* the prompt, and "Fix the
    // login bug" is a command as far as bash is concerned, which is worse than
    // refusing. A stopped session of either kind would swallow it.
    if (!session || !sessionCanTakeWork(session)) {
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
      if (stillThisProject(get().projectId, dispatched.projectId)) {
        set((state) => ({ tasks: replaceTask(state.tasks, dispatched) }));
      }
      // The backend cleared the last job's list with the assignment. Forget it
      // here so the rail does not keep showing a tally until the next load.
      useStepStore.getState().reset(sessionId);
      await talkToSession(session, dispatchPrompt(task));
      return true;
    } catch (error) {
      if (assigned) {
        try {
          const undone = await api.undispatchTask(taskId);
          if (stillThisProject(get().projectId, undone.projectId)) {
            set((state) => ({ tasks: replaceTask(state.tasks, undone) }));
          }
        } catch {
          // The prompt is still the failure to show.
        }
      }
      if (stillThisProject(get().projectId, origin)) {
        set({ error: errorMessage(error) });
      }
      return false;
    } finally {
      set((state) => ({ dispatching: { ...state.dispatching, [taskId]: false } }));
    }
  },

  dispatchToNewSession: async (taskId, projectId, paneId, options) => {
    const blocked = refuseInboxZero(projectId, get().tasks, options?.anyway === true);
    if (blocked !== null) {
      set({ error: blocked });
      return false;
    }
    const session = await useSessionStore.getState().startSession({
      projectId,
      paneId,
      kind: paneId === null ? "agent" : "grok",
      ...FALLBACK_PTY_SIZE,
    });
    // startSession has already put its own failure on the session store's error,
    // which the shell surfaces; repeating it here would show it twice.
    if (!session) return false;
    return get().dispatch(taskId, session.id, options);
  },

  editTask: (id, changes) => get().updateTask(id, changes),
}));

/** The tasks in one column, in the order the backend returned them. */
export function tasksInColumn(tasks: Task[], status: TaskStatus): Task[] {
  return tasks.filter((task) => task.status === status);
}

/**
 * Tasks that belong to this project. Do not use as a Zustand selector: a fresh
 * array every call loops React 19. `useTasksForProject` filters in `useMemo`.
 *
 * The board has to filter: `loadTasks` runs in an effect, so a switch paints
 * once with the previous project's rows still in the store.
 */
export function tasksForProject(tasks: Task[], projectId: string): Task[] {
  return tasks.filter((task) => task.projectId === projectId);
}

/** Filtered list for render. Selects `tasks` (stable until replaced) and filters in `useMemo`. */
export function useTasksForProject(projectId: string): Task[] {
  const tasks = useTaskStore((state) => state.tasks);
  return useMemo(() => tasksForProject(tasks, projectId), [tasks, projectId]);
}
