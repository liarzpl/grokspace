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

const { dispatchPrompt, tasksInColumn, useTaskStore } = await import("./taskStore");
const { useSessionStore } = await import("./sessionStore");

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

beforeEach(() => {
  vi.clearAllMocks();
  useTaskStore.setState(initialState, true);
  useSessionStore.setState(initialSessionState, true);
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
});

describe("moveTask", () => {
  it("replaces only the task that moved", async () => {
    useTaskStore.setState({ tasks: [task(), task({ id: "t2" })] });
    updateTask.mockResolvedValue(task({ status: "review" }));

    await useTaskStore.getState().moveTask("t1", "review");

    expect(updateTask).toHaveBeenCalledWith("t1", { status: "review" });
    expect(useTaskStore.getState().tasks.map((t) => t.status)).toEqual(["review", "backlog"]);
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
    expect(prompt).toBe("Fix the login bug — The session cookie is dropped on redirect.");
  });

  it("is just the title when there is nothing else to say", () => {
    expect(dispatchPrompt(task({ description: null }))).toBe("Fix the login bug");
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
    expect(writeSession).toHaveBeenCalledWith("s1", "Fix the login bug\r");
    expect(dispatchTask).toHaveBeenCalledWith("t1", "s1");
    const moved = useTaskStore.getState().tasks[0];
    expect(moved?.status).toBe("in_progress");
    expect(moved?.assignedSessionId).toBe("s1");
    expect(useTaskStore.getState().dispatching["t1"]).toBe(false);
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
    expect(promptSession).toHaveBeenCalledWith("s1", "Fix the login bug");
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
    expect(writeSession).toHaveBeenCalledWith("s9", "Fix the login bug\r");
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
    expect(promptSession).toHaveBeenCalledWith("a1", "Fix the login bug");
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
