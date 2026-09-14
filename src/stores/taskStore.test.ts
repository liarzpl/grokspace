import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session, Task } from "../types";

const listTasks = vi.fn();
const createTask = vi.fn();
const updateTask = vi.fn();
const dispatchTask = vi.fn();
const undispatchTask = vi.fn();
const removeTask = vi.fn();
const writeSession = vi.fn();
const promptSession = vi.fn();
const createSession = vi.fn();

// Mocked wholesale for the same reason sessionStore's tests do it: the real module
// pulls in xterm and its stylesheet, and this store only reaches sessionStore to
// find out whether a pane is running an agent.
vi.mock("../lib/terminals", () => ({ disposeTerminal: vi.fn(), detachTerminal: vi.fn() }));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      listTasks,
      createTask,
      updateTask,
      dispatchTask,
      undispatchTask,
      removeTask,
      writeSession,
      promptSession,
      createSession,
      listSessions: vi.fn(),
    },
  };
});

const { dispatchPrompt, inboxZeroBlockReason, tasksForProject, tasksInColumn, useTaskStore } =
  await import("./taskStore");
const { useSessionStore } = await import("./sessionStore");
const { useSettingsStore } = await import("./settingsStore");
const { useStepStore } = await import("./stepStore");
const { useUiStore } = await import("./uiStore");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "Fix the login bug",
    description: null,
    status: "backlog",
    assignedSessionId: null,
    priority: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    paneId: "0",
    processId: 4242,
    status: "running",
    title: "Grok",
    role: null,
    worktreePath: null,
    kind: "grok",
    exitCode: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

const initialState = useTaskStore.getState();
const initialSessionState = useSessionStore.getState();
const initialSettingsState = useSettingsStore.getState();
const initialStepState = useStepStore.getState();
const initialUiState = useUiStore.getState();

const ISOLATION_ERR =
  "isolation did not happen (this folder is not a git repository); confirm to start on the project tree";

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.getState().cancelUnisolatedStart();
  useTaskStore.setState(initialState, true);
  useSessionStore.setState(initialSessionState, true);
  useSettingsStore.setState(initialSettingsState, true);
  useStepStore.setState(initialStepState, true);
  useUiStore.setState(initialUiState, true);
});

describe("loadTasks", () => {
  it("takes the board the backend returns", async () => {
    listTasks.mockResolvedValue([task(), task({ id: "t2", status: "done" })]);

    await useTaskStore.getState().loadTasks("p1");

    expect(listTasks).toHaveBeenCalledWith("p1");
    expect(useTaskStore.getState().tasks).toHaveLength(2);
    expect(useTaskStore.getState().isLoading).toBe(false);
  });

  it("surfaces backend errors instead of throwing", async () => {
    listTasks.mockRejectedValue("database is locked");

    await useTaskStore.getState().loadTasks("p1");

    const state = useTaskStore.getState();
    expect(state.error).toBe("database is locked");
    expect(state.isLoading).toBe(false);
  });

  it("empties the previous project's tasks when the load fails", async () => {
    useTaskStore.setState({ tasks: [task()] });
    listTasks.mockRejectedValue("database is locked");

    await useTaskStore.getState().loadTasks("p2");

    expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it("clears leftover cards even when no project has been recorded yet", async () => {
    useTaskStore.setState({ tasks: [task()] });
    let resolveNext: (tasks: Task[]) => void = () => {};
    listTasks.mockImplementation(
      () =>
        new Promise<Task[]>((resolve) => {
          resolveNext = resolve;
        }),
    );

    const pending = useTaskStore.getState().loadTasks("p2");

    expect(useTaskStore.getState().tasks).toEqual([]);

    resolveNext([]);
    await pending;
  });

  it("empties the previous project's board before the next list arrives", async () => {
    useTaskStore.setState({ tasks: [task()], projectId: "p1", dispatching: { t1: true } });
    let resolveNext: (tasks: Task[]) => void = () => {};
    listTasks.mockImplementation(
      () =>
        new Promise<Task[]>((resolve) => {
          resolveNext = resolve;
        }),
    );

    const pending = useTaskStore.getState().loadTasks("p2");

    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(useTaskStore.getState().dispatching).toEqual({});
    expect(useTaskStore.getState().projectId).toBe("p2");
    expect(useTaskStore.getState().isLoading).toBe(true);

    resolveNext([task({ id: "t2", projectId: "p2" })]);
    await pending;

    expect(useTaskStore.getState().tasks.map((item) => item.id)).toEqual(["t2"]);
  });

  it("does not blank the current project's board while re-reading it", async () => {
    useTaskStore.setState({ tasks: [task()], projectId: "p1" });
    let resolveList: (tasks: Task[]) => void = () => {};
    listTasks.mockImplementation(
      () =>
        new Promise<Task[]>((resolve) => {
          resolveList = resolve;
        }),
    );

    const pending = useTaskStore.getState().loadTasks("p1");

    expect(useTaskStore.getState().tasks.map((item) => item.id)).toEqual(["t1"]);

    resolveList([task()]);
    await pending;
  });

  it("lets the later load win when two complete out of order", async () => {
    let resolveFirst: (tasks: Task[]) => void = () => {};
    listTasks.mockImplementation((projectId: string) => {
      if (projectId === "p1") {
        return new Promise<Task[]>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve([task({ id: "t2", projectId: "p2" })]);
    });

    const first = useTaskStore.getState().loadTasks("p1");
    const second = useTaskStore.getState().loadTasks("p2");
    await second;
    resolveFirst([task({ id: "t1", projectId: "p1" })]);
    await first;

    expect(useTaskStore.getState().tasks.map((item) => item.id)).toEqual(["t2"]);
  });
});

describe("createTask", () => {
  it("appends the created task", async () => {
    createTask.mockResolvedValue(task({ id: "t2", title: "Write the docs" }));
    useTaskStore.setState({ tasks: [task()] });

    await useTaskStore.getState().createTask("p1", "Write the docs");

    expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("leaves the board alone when the title is refused", async () => {
    createTask.mockRejectedValue("a task needs a title");

    const created = await useTaskStore.getState().createTask("p1", "   ");

    expect(created).toBeNull();
    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(useTaskStore.getState().error).toBe("a task needs a title");
  });

  it("does not keep a create that returns after the project has changed", async () => {
    useTaskStore.setState({ projectId: "p1" });
    let resolveCreate: (created: Task) => void = () => {};
    createTask.mockImplementation(
      () =>
        new Promise<Task>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const pending = useTaskStore.getState().createTask("p1", "Write the docs");
    useTaskStore.setState({ projectId: "p2", tasks: [] });
    resolveCreate(task({ id: "t2", title: "Write the docs" }));
    const created = await pending;

    expect(created).toBeNull();
    expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it("does not surface a refused create after the project has changed", async () => {
    useTaskStore.setState({ projectId: "p1" });
    let rejectCreate: (reason: unknown) => void = () => {};
    createTask.mockImplementation(
      () =>
        new Promise<Task>((_, reject) => {
          rejectCreate = reject;
        }),
    );

    const pending = useTaskStore.getState().createTask("p1", "Write the docs");
    useTaskStore.setState({ projectId: "p2" });
    rejectCreate("a task needs a title");
    await pending;

    expect(useTaskStore.getState().error).toBeNull();
  });
});

describe("editTask", () => {
  it("forwards an empty description so the backend can write NULL", async () => {
    useTaskStore.setState({ tasks: [task({ description: "Why it matters" })] });
    updateTask.mockResolvedValue(task({ description: null }));

    await useTaskStore.getState().editTask("t1", { description: "" });

    expect(updateTask).toHaveBeenCalledWith("t1", { description: "" });
    expect(useTaskStore.getState().tasks[0]?.description).toBeNull();
  });

  it("replaces the card the backend returns", async () => {
    useTaskStore.setState({ tasks: [task({ description: "Old" }), task({ id: "t2" })] });
    updateTask.mockResolvedValue(task({ description: "New why" }));

    await useTaskStore.getState().editTask("t1", { description: "New why" });

    expect(useTaskStore.getState().tasks.map((card) => card.description)).toEqual([
      "New why",
      null,
    ]);
  });

  it("does not surface a refused edit after the project has changed", async () => {
    useTaskStore.setState({ tasks: [task()], projectId: "p1" });
    let rejectEdit: (reason: unknown) => void = () => {};
    updateTask.mockImplementation(
      () =>
        new Promise<Task>((_, reject) => {
          rejectEdit = reject;
        }),
    );

    const pending = useTaskStore.getState().editTask("t1", { title: "Renamed" });
    useTaskStore.setState({ projectId: "p2", tasks: [] });
    rejectEdit("database is locked");
    await pending;

    expect(useTaskStore.getState().error).toBeNull();
  });
});

describe("moveTask", () => {
  it("replaces only the task that moved", async () => {
    useTaskStore.setState({ tasks: [task(), task({ id: "t2" })] });
    updateTask.mockResolvedValue(task({ status: "review" }));

    await useTaskStore.getState().moveTask("t1", "review");

    expect(updateTask).toHaveBeenCalledWith("t1", { status: "review" });
    expect(useTaskStore.getState().tasks.map((t) => t.status)).toEqual(["review", "backlog"]);
  });

  it("drops a move that returns after the project has changed", async () => {
    useTaskStore.setState({ tasks: [task()], projectId: "p1" });
    let resolveMove: (moved: Task) => void = () => {};
    updateTask.mockImplementation(
      () =>
        new Promise<Task>((resolve) => {
          resolveMove = resolve;
        }),
    );

    const pending = useTaskStore.getState().moveTask("t1", "review");
    useTaskStore.setState({ projectId: "p2", tasks: [task({ id: "t9", projectId: "p2" })] });
    resolveMove(task({ status: "review" }));
    await pending;

    expect(useTaskStore.getState().tasks.map((item) => item.id)).toEqual(["t9"]);
  });

  it("does not surface a refused move after the project has changed", async () => {
    useTaskStore.setState({ tasks: [task()], projectId: "p1" });
    let rejectMove: (reason: unknown) => void = () => {};
    updateTask.mockImplementation(
      () =>
        new Promise<Task>((_, reject) => {
          rejectMove = reject;
        }),
    );

    const pending = useTaskStore.getState().moveTask("t1", "review");
    useTaskStore.setState({ projectId: "p2", tasks: [] });
    rejectMove("database is locked");
    await pending;

    expect(useTaskStore.getState().error).toBeNull();
  });
});

describe("removeTask", () => {
  it("drops the task from the board", async () => {
    useTaskStore.setState({ tasks: [task(), task({ id: "t2" })] });
    removeTask.mockResolvedValue(undefined);

    await useTaskStore.getState().removeTask("t1");

    expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("keeps the task when the backend refuses", async () => {
    useTaskStore.setState({ tasks: [task()] });
    removeTask.mockRejectedValue("no task found with id t1");

    await useTaskStore.getState().removeTask("t1");

    expect(useTaskStore.getState().tasks).toHaveLength(1);
  });

  it("drops a delete that returns after the project has changed", async () => {
    useTaskStore.setState({ tasks: [task()], projectId: "p1" });
    let resolveRemove: () => void = () => {};
    removeTask.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRemove = resolve;
        }),
    );

    const pending = useTaskStore.getState().removeTask("t1");
    useTaskStore.setState({ projectId: "p2", tasks: [task({ id: "t1", projectId: "p2" })] });
    resolveRemove();
    await pending;

    expect(useTaskStore.getState().tasks).toHaveLength(1);
    expect(useTaskStore.getState().tasks[0]?.projectId).toBe("p2");
  });

  it("does not surface a refused delete after the project has changed", async () => {
    useTaskStore.setState({ tasks: [task()], projectId: "p1" });
    let rejectRemove: (reason: unknown) => void = () => {};
    removeTask.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectRemove = reject;
        }),
    );

    const pending = useTaskStore.getState().removeTask("t1");
    useTaskStore.setState({ projectId: "p2", tasks: [] });
    rejectRemove("no task found with id t1");
    await pending;

    expect(useTaskStore.getState().error).toBeNull();
  });
});

describe("dispatchPrompt", () => {
  it("is one line, because a newline submits in a TUI", () => {
    const prompt = dispatchPrompt(
      task({
        title: "Fix the login bug",
        description: "The session cookie\nis dropped on\n  redirect.",
      }),
    );

    expect(prompt).not.toContain("\n");
    expect(prompt).toBe(
      "Fix the login bug — The session cookie is dropped on redirect. Write your steps to $GROKSPACE_STEPS_FILE first, then wait.",
    );
  });

  it("is just the title and the steps gate when there is nothing else to say", () => {
    expect(dispatchPrompt(task({ description: null }))).toBe(
      "Fix the login bug. Write your steps to $GROKSPACE_STEPS_FILE first, then wait.",
    );
  });
});

describe("inboxZeroBlockReason", () => {
  it("does nothing while the setting is off, even with a waiting inbox", () => {
    expect(inboxZeroBlockReason("off", 2, false)).toBeNull();
  });

  it("does nothing when Needs you is empty", () => {
    expect(inboxZeroBlockReason("on", 0, false)).toBeNull();
  });

  it("names the wait when the gate is on", () => {
    expect(inboxZeroBlockReason("on", 1, false)).toContain("Needs you is waiting");
    expect(inboxZeroBlockReason("on", 2, false)).toContain("2 Needs you waits");
  });

  it("lets a typed override through", () => {
    expect(inboxZeroBlockReason("on", 1, true)).toBeNull();
  });
});

describe("dispatch", () => {
  it("records the assignment, then types the task into the agent", async () => {
    const order: string[] = [];
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({ sessions: [session()] });
    dispatchTask.mockImplementation(async () => {
      order.push("dispatch");
      return task({ status: "in_progress", assignedSessionId: "s1" });
    });
    writeSession.mockImplementation(async () => {
      order.push("write");
    });

    const ok = await useTaskStore.getState().dispatch("t1", "s1");

    expect(ok).toBe(true);
    expect(order).toEqual(["dispatch", "write"]);
    expect(writeSession).toHaveBeenCalledWith(
      "s1",
      "Fix the login bug. Write your steps to $GROKSPACE_STEPS_FILE first, then wait.\r",
    );
    expect(dispatchTask).toHaveBeenCalledWith("t1", "s1");
    const moved = useTaskStore.getState().tasks[0];
    expect(moved?.status).toBe("in_progress");
    expect(moved?.assignedSessionId).toBe("s1");
    expect(useTaskStore.getState().dispatching["t1"]).toBe(false);
  });

  it("clears the session's previous steps so the last job's tally does not linger", async () => {
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({ sessions: [session()] });
    useStepStore.setState({
      bySession: {
        s1: {
          sessionId: "s1",
          phase: "approved",
          steps: [
            {
              id: "a",
              sessionId: "s1",
              sortIndex: 0,
              title: "The last job",
              status: "done",
              origin: "agent",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          isLoading: false,
        },
      },
    });
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "s1" }));
    writeSession.mockResolvedValue(undefined);

    await useTaskStore.getState().dispatch("t1", "s1");

    const steps = useStepStore.getState().bySession["s1"];
    expect(steps?.phase).toBe("none");
    expect(steps?.steps).toEqual([]);
  });

  it("unassigns the task when the prompt is refused", async () => {
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({ sessions: [session()] });
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "s1" }));
    writeSession.mockRejectedValue("that session is no longer running");
    undispatchTask.mockResolvedValue(task({ status: "backlog", assignedSessionId: null }));

    const ok = await useTaskStore.getState().dispatch("t1", "s1");

    expect(ok).toBe(false);
    expect(dispatchTask).toHaveBeenCalledWith("t1", "s1");
    expect(undispatchTask).toHaveBeenCalledWith("t1");
    expect(useTaskStore.getState().tasks[0]?.status).toBe("backlog");
    expect(useTaskStore.getState().tasks[0]?.assignedSessionId).toBeNull();
    expect(useTaskStore.getState().error).toBe("that session is no longer running");
  });

  it("does not surface a refused dispatch after the project has changed", async () => {
    useTaskStore.setState({ tasks: [task()], projectId: "p1" });
    useSessionStore.setState({ sessions: [session()] });
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "s1" }));
    let rejectWrite: (reason: unknown) => void = () => {};
    writeSession.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectWrite = reject;
        }),
    );
    undispatchTask.mockResolvedValue(task({ status: "backlog", assignedSessionId: null }));

    const pending = useTaskStore.getState().dispatch("t1", "s1");
    await Promise.resolve();
    useTaskStore.setState({ projectId: "p2", tasks: [] });
    rejectWrite("that session is no longer running");
    await pending;

    expect(useTaskStore.getState().error).toBeNull();
  });

  it("refuses a session that has stopped", async () => {
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({ sessions: [session({ status: "stopped" })] });

    const ok = await useTaskStore.getState().dispatch("t1", "s1");

    expect(ok).toBe(false);
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("refuses a shell, which would try to run the task as a command", async () => {
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({ sessions: [session({ kind: "shell" })] });

    const ok = await useTaskStore.getState().dispatch("t1", "s1");

    expect(ok).toBe(false);
    expect(writeSession).not.toHaveBeenCalled();
    expect(useTaskStore.getState().error).toContain("agent");
  });

  it("asks an agent rather than typing at it", async () => {
    // The difference the ACP session buys: a request has a reply, so the session
    // can report going back to idle. A terminal can only be written into.
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    promptSession.mockResolvedValue(undefined);
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "s1" }));

    const ok = await useTaskStore.getState().dispatch("t1", "s1");

    expect(ok).toBe(true);
    expect(promptSession).toHaveBeenCalledWith(
      "s1",
      "Fix the login bug. Write your steps to $GROKSPACE_STEPS_FILE first, then wait.",
    );
    expect(writeSession).not.toHaveBeenCalled();
    // No trailing carriage return: nothing is being typed, so there is no line to
    // submit.
    expect(promptSession.mock.calls[0]?.[1]).not.toContain("\r");
  });

  it("takes work to an idle agent, which a terminal never reports", async () => {
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({
      sessions: [session({ kind: "agent", paneId: null, status: "idle" })],
    });
    promptSession.mockResolvedValue(undefined);
    dispatchTask.mockResolvedValue(task({ status: "in_progress" }));

    expect(await useTaskStore.getState().dispatch("t1", "s1")).toBe(true);
  });

  it("refuses an agent that is already blocked on a question", async () => {
    // A second prompt would queue behind something nobody has answered.
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({
      sessions: [session({ kind: "agent", paneId: null, status: "needs_input" })],
    });

    const ok = await useTaskStore.getState().dispatch("t1", "s1");

    expect(ok).toBe(false);
    expect(promptSession).not.toHaveBeenCalled();
  });

  it("refuses a new card while Needs you is waiting and the gate is on", async () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, inboxZeroGate: "on" },
    });
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({
      sessions: [
        session(),
        session({ id: "wait", kind: "agent", paneId: null, status: "running" }),
      ],
    });
    useUiStore.setState({
      permissions: { wait: [{ requestId: 1, summary: "Edit src/a.ts" }] },
    });

    const ok = await useTaskStore.getState().dispatch("t1", "s1");

    expect(ok).toBe(false);
    expect(dispatchTask).not.toHaveBeenCalled();
    expect(useTaskStore.getState().error).toContain("Needs you is waiting");
  });

  it("hands the card over after a typed dispatch anyway", async () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, inboxZeroGate: "on" },
    });
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({
      sessions: [
        session(),
        session({ id: "wait", kind: "agent", paneId: null, status: "running" }),
      ],
    });
    useUiStore.setState({
      permissions: { wait: [{ requestId: 1, summary: "Edit src/a.ts" }] },
    });
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "s1" }));
    writeSession.mockResolvedValue(undefined);

    const ok = await useTaskStore.getState().dispatch("t1", "s1", { anyway: true });

    expect(ok).toBe(true);
    expect(dispatchTask).toHaveBeenCalledWith("t1", "s1");
  });

  it("still dispatches when the inbox is empty and the gate is on", async () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, inboxZeroGate: "on" },
    });
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({ sessions: [session()] });
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "s1" }));
    writeSession.mockResolvedValue(undefined);

    expect(await useTaskStore.getState().dispatch("t1", "s1")).toBe(true);
    expect(dispatchTask).toHaveBeenCalled();
  });

  it("does not gate while the setting is off, even with a pending permission", async () => {
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({
      sessions: [
        session(),
        session({ id: "wait", kind: "agent", paneId: null, status: "running" }),
      ],
    });
    useUiStore.setState({
      permissions: { wait: [{ requestId: 1, summary: "Edit src/a.ts" }] },
    });
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "s1" }));
    writeSession.mockResolvedValue(undefined);

    expect(await useTaskStore.getState().dispatch("t1", "s1")).toBe(true);
    expect(dispatchTask).toHaveBeenCalled();
  });
});

describe("dispatchToNewSession", () => {
  it("starts an agent in the pane and sends the task to it", async () => {
    useTaskStore.setState({ tasks: [task()] });
    createSession.mockResolvedValue(session({ id: "s9", paneId: "2" }));
    writeSession.mockResolvedValue(undefined);
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "s9" }));

    const ok = await useTaskStore.getState().dispatchToNewSession("t1", "p1", "2");

    expect(ok).toBe(true);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", paneId: "2", kind: "grok" }),
    );
    expect(writeSession).toHaveBeenCalledWith(
      "s9",
      "Fix the login bug. Write your steps to $GROKSPACE_STEPS_FILE first, then wait.\r",
    );
    expect(useTaskStore.getState().tasks[0]?.assignedSessionId).toBe("s9");
  });

  it("starts a paneless agent when no pane is named", async () => {
    // A full grid must not be the reason a task cannot be dispatched, which is why
    // the agent target needs no pane.
    useTaskStore.setState({ tasks: [task()] });
    createSession.mockResolvedValue(session({ id: "a1", kind: "agent", paneId: null }));
    promptSession.mockResolvedValue(undefined);
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "a1" }));

    const ok = await useTaskStore.getState().dispatchToNewSession("t1", "p1", null);

    expect(ok).toBe(true);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: null, kind: "agent" }),
    );
    expect(promptSession).toHaveBeenCalledWith(
      "a1",
      "Fix the login bug. Write your steps to $GROKSPACE_STEPS_FILE first, then wait.",
    );
  });

  it("gives up quietly when the agent will not start", async () => {
    // startSession has already put the reason on the session store, and the shell
    // shows that; saying it twice would be two banners for one failure.
    useTaskStore.setState({ tasks: [task()] });
    createSession.mockRejectedValue("could not find `grok` on PATH");

    const ok = await useTaskStore.getState().dispatchToNewSession("t1", "p1", "2");

    expect(ok).toBe(false);
    expect(writeSession).not.toHaveBeenCalled();
    expect(useTaskStore.getState().error).toBeNull();
    expect(useSessionStore.getState().error).toBe("could not find `grok` on PATH");
  });

  it("retries the new agent with allowUnisolated after confirm", async () => {
    useTaskStore.setState({ tasks: [task()] });
    createSession
      .mockRejectedValueOnce(ISOLATION_ERR)
      .mockResolvedValueOnce(session({ id: "a1", kind: "agent", paneId: null }));
    promptSession.mockResolvedValue(undefined);
    dispatchTask.mockResolvedValue(task({ status: "in_progress", assignedSessionId: "a1" }));

    const pending = useTaskStore.getState().dispatchToNewSession("t1", "p1", null);
    await vi.waitFor(() => expect(useSessionStore.getState().isolationConfirm).not.toBeNull());
    useSessionStore.getState().confirmUnisolatedStart();

    expect(await pending).toBe(true);
    expect(createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ allowUnisolated: true }),
    );
  });

  it("does not start an agent when the inbox-zero gate refuses", async () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, inboxZeroGate: "on" },
    });
    useTaskStore.setState({ tasks: [task()] });
    useSessionStore.setState({
      sessions: [session({ id: "wait", kind: "agent", paneId: null, status: "running" })],
    });
    useUiStore.setState({
      permissions: { wait: [{ requestId: 1, summary: "Edit src/a.ts" }] },
    });

    const ok = await useTaskStore.getState().dispatchToNewSession("t1", "p1", null);

    expect(ok).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("tasksInColumn", () => {
  it("keeps the backend's order within a column", () => {
    const tasks = [
      task({ id: "a", status: "backlog" }),
      task({ id: "b", status: "done" }),
      task({ id: "c", status: "backlog" }),
    ];

    expect(tasksInColumn(tasks, "backlog").map((t) => t.id)).toEqual(["a", "c"]);
    expect(tasksInColumn(tasks, "review")).toEqual([]);
  });
});

describe("tasksForProject", () => {
  it("hides another project's cards from the board and the header tally", () => {
    const tasks = [task(), task({ id: "t2", projectId: "p2" })];

    expect(tasksForProject(tasks, "p1").map((item) => item.id)).toEqual(["t1"]);
    expect(tasksForProject(tasks, "p2").map((item) => item.id)).toEqual(["t2"]);
    expect(tasksForProject(tasks, "p2")).toHaveLength(1);
  });
});
