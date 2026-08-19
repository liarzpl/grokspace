import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../types";

const listSessions = vi.fn();
const createSession = vi.fn();
const stopSession = vi.fn();
const restartSession = vi.fn();
const renameSession = vi.fn();
const closeSession = vi.fn();
const mergeSessionWorktree = vi.fn();
const discardSessionWorktree = vi.fn();
const answerSessionPermission = vi.fn();
const promptSession = vi.fn();
const cancelSession = vi.fn();
const disposeTerminal = vi.fn();
const detachTerminal = vi.fn();

// Mocked wholesale: the real module pulls in xterm and its stylesheet, neither
// of which belongs in a store test.
vi.mock("../lib/terminals", () => ({ disposeTerminal, detachTerminal }));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      listSessions,
      createSession,
      stopSession,
      restartSession,
      renameSession,
      closeSession,
      discardSessionWorktree,
      mergeSessionWorktree,
      answerSessionPermission,
      promptSession,
      cancelSession,
    },
  };
});

const { sessionForPane, sessionsForProject, useSessionStore } = await import("./sessionStore");
const { useGraphStore } = await import("./graphStore");
const { useStepStore } = await import("./stepStore");

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

/** Stands in for a graph the store had already read for a session. */
function graphEntry() {
  return {
    path: "/p/.grokspace/graphs/s.json",
    graph: null,
    warnings: [],
    error: null,
    updatedAt: 1000,
    isLoading: false,
  };
}

/** Stands in for a step list the store had already read for a session. */
function stepEntry() {
  return {
    sessionId: "s1",
    phase: "proposed" as const,
    steps: [
      {
        id: "a",
        sessionId: "s1",
        sortIndex: 0,
        title: "Read it",
        status: "pending" as const,
        origin: "agent" as const,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    isLoading: false,
  };
}

const initialState = useSessionStore.getState();
const initialGraphState = useGraphStore.getState();
const initialStepState = useStepStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState(initialState, true);
  useGraphStore.setState(initialGraphState, true);
  useStepStore.setState(initialStepState, true);
});

describe("loadSessions", () => {
  it("replaces the list and drops any maximized pane from the last project", async () => {
    useSessionStore.setState({ maximizedPane: "2" });
    listSessions.mockResolvedValue([session()]);

    await useSessionStore.getState().loadSessions("p1");

    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.maximizedPane).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it("surfaces backend errors instead of throwing", async () => {
    listSessions.mockRejectedValue("database is locked");

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().error).toBe("database is locked");
  });

  it("empties the previous project's sessions when the load fails", async () => {
    useSessionStore.setState({
      sessions: [session()],
      permissions: { s1: [{ requestId: 1, summary: "Write a file" }] },
    });
    listSessions.mockRejectedValue("database is locked");

    await useSessionStore.getState().loadSessions("p2");

    const state = useSessionStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.permissions).toEqual({});
  });

  it("replaces pending permissions from the arriving list", async () => {
    useSessionStore.setState({
      sessions: [session({ id: "old" })],
      permissions: { old: [{ requestId: 1, summary: "Stale" }] },
    });
    listSessions.mockResolvedValue([
      session({
        id: "s1",
        pendingPermissions: [{ requestId: 9, summary: "Write a file" }],
      }),
    ]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().permissions).toEqual({
      s1: [{ requestId: 9, summary: "Write a file" }],
    });
  });

  it("lets the later load win when two complete out of order", async () => {
    let resolveFirst: (sessions: Session[]) => void = () => {};
    listSessions.mockImplementation((projectId: string) => {
      if (projectId === "p1") {
        return new Promise<Session[]>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve([session({ id: "s2", projectId: "p2" })]);
    });

    const first = useSessionStore.getState().loadSessions("p1");
    const second = useSessionStore.getState().loadSessions("p2");
    await second;
    resolveFirst([session({ id: "s1", projectId: "p1" })]);
    await first;

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual(["s2"]);
  });

  it("drops the graphs of the project being left", async () => {
    useSessionStore.setState({ sessions: [session(), session({ id: "s2", paneId: "1" })] });
    useGraphStore.setState({ bySession: { s1: graphEntry(), s2: graphEntry() } });
    listSessions.mockResolvedValue([session({ id: "s3", projectId: "p2" })]);

    await useSessionStore.getState().loadSessions("p2");

    expect(useGraphStore.getState().bySession).toEqual({});
  });

  it("keeps the graphs of sessions that are still there", async () => {
    useSessionStore.setState({ sessions: [session()] });
    useGraphStore.setState({ bySession: { s1: graphEntry() } });
    listSessions.mockResolvedValue([session()]);

    // Reading the same project again — a remount, not a switch — must not blank
    // a panel that is already showing the right graph.
    await useSessionStore.getState().loadSessions("p1");

    expect(Object.keys(useGraphStore.getState().bySession)).toEqual(["s1"]);
    expect(detachTerminal).not.toHaveBeenCalled();
  });

  it("empties the previous project's panes before the next list arrives", async () => {
    useSessionStore.setState({
      sessions: [session()],
      permissions: { s1: [{ requestId: 1, summary: "Write a file" }] },
      transcript: { s1: [{ kind: "message", text: "hello" }] },
    });
    useGraphStore.setState({ bySession: { s1: graphEntry() } });
    let resolveNext: (sessions: Session[]) => void = () => {};
    listSessions.mockImplementation(
      () =>
        new Promise<Session[]>((resolve) => {
          resolveNext = resolve;
        }),
    );

    const pending = useSessionStore.getState().loadSessions("p2");

    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().permissions).toEqual({});
    expect(detachTerminal).toHaveBeenCalledWith("s1");
    expect(useGraphStore.getState().bySession).toEqual({});
    // The conversation is still running; coming back should not start from blank.
    expect(useSessionStore.getState().transcript["s1"]?.[0]?.text).toBe("hello");

    resolveNext([session({ id: "s2", projectId: "p2" })]);
    await pending;

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual(["s2"]);
    expect(useSessionStore.getState().transcript["s1"]?.[0]?.text).toBe("hello");
  });

  it("does not blank the current project's panes while re-reading them", async () => {
    useSessionStore.setState({ sessions: [session()] });
    let resolveList: (sessions: Session[]) => void = () => {};
    listSessions.mockImplementation(
      () =>
        new Promise<Session[]>((resolve) => {
          resolveList = resolve;
        }),
    );

    const pending = useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual(["s1"]);
    expect(detachTerminal).not.toHaveBeenCalled();

    resolveList([session()]);
    await pending;
  });

  it("drops transcripts of sessions that disappeared from the same project", async () => {
    useSessionStore.setState({
      sessions: [session(), session({ id: "s2", paneId: "1" })],
      transcript: {
        s1: [{ kind: "message", text: "keep" }],
        s2: [{ kind: "message", text: "gone" }],
      },
    });
    listSessions.mockResolvedValue([session()]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().transcript).toEqual({
      s1: [{ kind: "message", text: "keep" }],
    });
    expect(detachTerminal).not.toHaveBeenCalled();
  });

  it("drops the step lists of the project being left", async () => {
    useSessionStore.setState({ sessions: [session(), session({ id: "s2", paneId: "1" })] });
    useStepStore.setState({ bySession: { s1: stepEntry(), s2: { ...stepEntry(), sessionId: "s2" } } });
    listSessions.mockResolvedValue([session({ id: "s3", projectId: "p2" })]);

    await useSessionStore.getState().loadSessions("p2");

    expect(useStepStore.getState().bySession).toEqual({});
  });
});

describe("startSession", () => {
  it("adds the session and clears the pane's busy flag", async () => {
    createSession.mockResolvedValue(session());

    const started = await useSessionStore
      .getState()
      .startSession({ projectId: "p1", paneId: "0", kind: "grok", cols: 80, rows: 24 });

    expect(started?.id).toBe("s1");
    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.busyPanes["0"]).toBe(false);
  });

  it("greets a new session with the terminal, not the last one's graph", async () => {
    useSessionStore.setState({ paneViews: { "0": "graph" } });
    createSession.mockResolvedValue(session());

    await useSessionStore
      .getState()
      .startSession({ projectId: "p1", paneId: "0", kind: "grok", cols: 80, rows: 24 });

    expect(useSessionStore.getState().paneViews["0"]).toBe("terminal");
  });

  it("keeps at most one session per pane", async () => {
    useSessionStore.setState({ sessions: [session({ id: "old", paneId: "0" })] });
    createSession.mockResolvedValue(session({ id: "new", paneId: "0" }));

    await useSessionStore
      .getState()
      .startSession({ projectId: "p1", paneId: "0", kind: "shell", cols: 80, rows: 24 });

    const { sessions } = useSessionStore.getState();
    expect(sessions.map((s) => s.id)).toEqual(["new"]);
  });

  it("reports a missing grok binary and leaves the pane free", async () => {
    createSession.mockRejectedValue("could not find `grok` on PATH");

    const started = await useSessionStore
      .getState()
      .startSession({ projectId: "p1", paneId: "1", kind: "grok", cols: 80, rows: 24 });

    const state = useSessionStore.getState();
    expect(started).toBeNull();
    expect(state.error).toContain("could not find `grok`");
    expect(state.sessions).toEqual([]);
    expect(state.busyPanes["1"]).toBe(false);
  });
});

describe("markExited", () => {
  it("marks the session stopped and drops its stale pid", () => {
    useSessionStore.setState({ sessions: [session()] });

    useSessionStore.getState().markExited("s1", 130);

    const [updated] = useSessionStore.getState().sessions;
    expect(updated?.status).toBe("stopped");
    expect(updated?.exitCode).toBe(130);
    expect(updated?.processId).toBeNull();
  });

  it("ignores an exit for a session that was already closed", () => {
    useSessionStore.setState({ sessions: [session()] });

    useSessionStore.getState().markExited("already-gone", 0);

    expect(useSessionStore.getState().sessions[0]?.status).toBe("running");
  });
});

describe("stopSession", () => {
  it("leaves the status to the exit event rather than guessing it", async () => {
    // A kill is asynchronous: the child is still running when this resolves, and
    // the pane would lie if it went grey before the process actually went away.
    useSessionStore.setState({ sessions: [session({ status: "running" })] });
    stopSession.mockResolvedValue(undefined);

    await useSessionStore.getState().stopSession("s1");

    expect(stopSession).toHaveBeenCalledWith("s1");
    const stopped = useSessionStore.getState().sessions[0];
    expect(stopped?.status).toBe("running");
    expect(stopped?.processId).toBe(4242);
  });

  it("surfaces a failed kill instead of throwing", async () => {
    useSessionStore.setState({ sessions: [session()] });
    stopSession.mockRejectedValue("no such session");

    await useSessionStore.getState().stopSession("s1");

    expect(useSessionStore.getState().error).toBe("no such session");
  });
});

describe("renameSession", () => {
  it("replaces only the session that was renamed", async () => {
    useSessionStore.setState({
      sessions: [session(), session({ id: "s2", paneId: "1", title: "Shell" })],
    });
    renameSession.mockResolvedValue(session({ title: "Reviewer" }));

    await useSessionStore.getState().renameSession("s1", "Reviewer");

    expect(renameSession).toHaveBeenCalledWith("s1", "Reviewer");
    expect(useSessionStore.getState().sessions.map((s) => s.title)).toEqual([
      "Reviewer",
      "Shell",
    ]);
  });

  it("keeps the old title when the backend refuses the new one", async () => {
    useSessionStore.setState({ sessions: [session({ title: "Grok" })] });
    renameSession.mockRejectedValue("a session needs a title");

    await useSessionStore.getState().renameSession("s1", "   ");

    const state = useSessionStore.getState();
    expect(state.error).toBe("a session needs a title");
    expect(state.sessions[0]?.title).toBe("Grok");
  });
});

describe("markStatus", () => {
  it("takes the agent's own account of what it is doing", async () => {
    // A terminal never sends these; only an ACP session can say more than running.
    useSessionStore.setState({
      sessions: [session({ kind: "agent", paneId: null }), session({ id: "s2", paneId: "1" })],
    });

    useSessionStore.getState().markStatus("s1", "needs_input");

    const [agent, terminal] = useSessionStore.getState().sessions;
    expect(agent?.status).toBe("needs_input");
    expect(terminal?.status).toBe("running");
  });
});

describe("permissions", () => {
  const asked = { requestId: 9, summary: "Run `git push`" };

  it("keeps one per request, since an agent can be blocked on several", () => {
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useSessionStore.getState().askPermission("s1", asked);
    useSessionStore.getState().askPermission("s1", { requestId: 10, summary: "Write a file" });

    expect(useSessionStore.getState().permissions["s1"]).toHaveLength(2);
  });

  it("drops only the one that was answered", async () => {
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useSessionStore.getState().askPermission("s1", asked);
    useSessionStore.getState().askPermission("s1", { requestId: 10, summary: "Write a file" });
    answerSessionPermission.mockResolvedValue(undefined);

    await useSessionStore.getState().answerPermission("s1", 9, true);

    expect(answerSessionPermission).toHaveBeenCalledWith("s1", 9, true);
    expect(useSessionStore.getState().permissions["s1"]?.map((p) => p.requestId)).toEqual([10]);
  });

  it("leaves the question standing when the answer could not be sent", async () => {
    // The agent is still waiting either way, so the buttons have to stay.
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useSessionStore.getState().askPermission("s1", asked);
    answerSessionPermission.mockRejectedValue("that session is no longer running");

    await useSessionStore.getState().answerPermission("s1", 9, true);

    expect(useSessionStore.getState().permissions["s1"]).toHaveLength(1);
    expect(useSessionStore.getState().error).toBe("that session is no longer running");
  });

  it("forgets what a session that has gone was asking", () => {
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useSessionStore.getState().askPermission("s1", asked);

    useSessionStore.getState().markExited("s1", null);

    expect(useSessionStore.getState().permissions["s1"]).toBeUndefined();
  });

  it("ignores a prompt for a session that is not in the list", () => {
    useSessionStore.getState().askPermission("gone", asked);

    expect(useSessionStore.getState().permissions["gone"]).toBeUndefined();
  });
});

describe("startSession", () => {
  it("does not invent a pane for an agent that has none", async () => {
    createSession.mockResolvedValue(session({ id: "a1", kind: "agent", paneId: null }));

    await useSessionStore
      .getState()
      .startSession({ projectId: "p1", paneId: null, kind: "agent", cols: 80, rows: 24 });

    const state = useSessionStore.getState();
    expect(state.busyPanes).toEqual({});
    expect(state.paneViews).toEqual({});
  });

  it("lets two agents coexist rather than displacing each other", async () => {
    // Both have no pane, and a null pane must not read as the same pane.
    useSessionStore.setState({ sessions: [session({ id: "a1", kind: "agent", paneId: null })] });
    createSession.mockResolvedValue(session({ id: "a2", kind: "agent", paneId: null }));

    await useSessionStore
      .getState()
      .startSession({ projectId: "p1", paneId: null, kind: "agent", cols: 80, rows: 24 });

    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["a1", "a2"]);
  });
});

describe("launchSwarm", () => {
  const roles = [
    { name: "Planner", summary: "plans", brief: "You are the planner." },
    { name: "Reviewer", summary: "reviews", brief: "You are reviewing." },
  ];

  it("starts one paneless agent per role and tells each what it is for", async () => {
    // Five roles do not fit a six-pane grid, and an agent is the kind that can report
    // what it is doing, so a swarm is agents rather than terminals.
    createSession.mockImplementation((input: { role?: string }) =>
      Promise.resolve(session({ id: `s-${input.role ?? "?"}`, kind: "agent", paneId: null })),
    );
    promptSession.mockResolvedValue(undefined);

    const failed = await useSessionStore.getState().launchSwarm("p1", roles);

    expect(failed).toEqual([]);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ paneId: null, kind: "agent", role: "Planner" }),
    );
    expect(promptSession).toHaveBeenNthCalledWith(1, "s-Planner", expect.stringContaining("planner"));
    // The memory is named in every brief, since the file always exists for a session
    // GrokSpace started.
    expect(promptSession).toHaveBeenNthCalledWith(
      2,
      "s-Reviewer",
      expect.stringContaining("GROKSPACE_MEMORY_FILE"),
    );
  });

  it("keeps going when one role will not start, and says which", async () => {
    // Throwing the other four away because the fifth failed would be the wrong trade.
    createSession.mockImplementation((input: { role?: string }) =>
      input.role === "Planner"
        ? Promise.reject("could not find `grok` on PATH")
        : Promise.resolve(session({ id: "s-reviewer", kind: "agent", paneId: null })),
    );
    promptSession.mockResolvedValue(undefined);

    const failed = await useSessionStore.getState().launchSwarm("p1", roles);

    expect(failed).toEqual(["Planner"]);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["s-reviewer"]);
  });

  it("counts a session that started but could not be briefed as failed", async () => {
    // Worse than not starting: it would sit there looking ready and knowing nothing.
    createSession.mockResolvedValue(session({ id: "s-planner", kind: "agent", paneId: null }));
    promptSession.mockRejectedValue("that session is no longer running");

    const failed = await useSessionStore.getState().launchSwarm("p1", [roles[0]!]);

    expect(failed).toEqual(["Planner"]);
    expect(useSessionStore.getState().error).toBe("that session is no longer running");
  });
});

describe("restartSession", () => {
  it("swaps in the new session and disposes the old terminal", async () => {
    useSessionStore.setState({
      sessions: [session({ id: "old", paneId: "1" })],
      transcript: { old: [{ kind: "message", text: "previous run" }] },
    });
    restartSession.mockResolvedValue(session({ id: "fresh", paneId: "1" }));

    await useSessionStore.getState().restartSession("old", 100, 30);

    expect(restartSession).toHaveBeenCalledWith("old", 100, 30);
    // Restarting mints a new id, so the old xterm instance has to go.
    expect(disposeTerminal).toHaveBeenCalledWith("old");
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["fresh"]);
    expect(useSessionStore.getState().transcript["old"]).toBeUndefined();
  });

  it("does not carry the previous run's graph over to the new session", async () => {
    useSessionStore.setState({ sessions: [session({ id: "old", paneId: "1" })] });
    useGraphStore.setState({ bySession: { old: graphEntry() } });
    restartSession.mockResolvedValue(session({ id: "fresh", paneId: "1" }));

    await useSessionStore.getState().restartSession("old", 100, 30);

    expect(useGraphStore.getState().bySession).toEqual({});
  });

  it("does not carry the previous run's steps over to the new session", async () => {
    useSessionStore.setState({ sessions: [session({ id: "old", paneId: "1" })] });
    useStepStore.setState({ bySession: { old: { ...stepEntry(), sessionId: "old" } } });
    restartSession.mockResolvedValue(session({ id: "fresh", paneId: "1" }));

    await useSessionStore.getState().restartSession("old", 100, 30);

    expect(useStepStore.getState().bySession).toEqual({});
  });
});

describe("closeSession", () => {
  it("frees the pane and disposes the terminal", async () => {
    useSessionStore.setState({
      sessions: [session(), session({ id: "s2", paneId: "1" })],
      transcript: { s1: [{ kind: "message", text: "hello" }], s2: [{ kind: "tool", text: "Read" }] },
    });
    closeSession.mockResolvedValue(undefined);

    await useSessionStore.getState().closeSession("s1");

    expect(disposeTerminal).toHaveBeenCalledWith("s1");
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(useSessionStore.getState().transcript["s1"]).toBeUndefined();
    expect(useSessionStore.getState().transcript["s2"]?.[0]?.text).toBe("Read");
  });

  it("drops the closed session's graph and leaves the other pane's alone", async () => {
    useSessionStore.setState({ sessions: [session(), session({ id: "s2", paneId: "1" })] });
    useGraphStore.setState({ bySession: { s1: graphEntry(), s2: graphEntry() } });
    closeSession.mockResolvedValue(undefined);

    await useSessionStore.getState().closeSession("s1");

    expect(Object.keys(useGraphStore.getState().bySession)).toEqual(["s2"]);
  });

  it("drops the closed session's steps and leaves the other pane's alone", async () => {
    useSessionStore.setState({ sessions: [session(), session({ id: "s2", paneId: "1" })] });
    useStepStore.setState({
      bySession: { s1: stepEntry(), s2: { ...stepEntry(), sessionId: "s2" } },
    });
    closeSession.mockResolvedValue(undefined);

    await useSessionStore.getState().closeSession("s1");

    expect(Object.keys(useStepStore.getState().bySession)).toEqual(["s2"]);
  });

  it("keeps the session when the backend refuses", async () => {
    useSessionStore.setState({ sessions: [session()] });
    closeSession.mockRejectedValue("busy");

    await useSessionStore.getState().closeSession("s1");

    expect(useSessionStore.getState().sessions).toHaveLength(1);
    expect(disposeTerminal).not.toHaveBeenCalled();
  });
});

describe("discardWorktree", () => {
  it("clears the path on the session that kept its files", async () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          status: "stopped",
          worktreePath: "/tmp/tree",
        }),
      ],
    });
    discardSessionWorktree.mockResolvedValue(
      session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "stopped",
        worktreePath: null,
      }),
    );

    await useSessionStore.getState().discardWorktree("agent-1");

    expect(discardSessionWorktree).toHaveBeenCalledWith("agent-1");
    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBeNull();
  });

  it("keeps the path when the backend refuses", async () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          status: "running",
          worktreePath: "/tmp/tree",
        }),
      ],
    });
    discardSessionWorktree.mockRejectedValue("stop the agent first");

    await useSessionStore.getState().discardWorktree("agent-1");

    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBe("/tmp/tree");
    expect(useSessionStore.getState().error).toContain("stop the agent first");
  });
});

describe("mergeWorktree", () => {
  it("clears the path once the branch has landed on the project", async () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          status: "stopped",
          worktreePath: "/tmp/tree",
        }),
      ],
    });
    mergeSessionWorktree.mockResolvedValue(
      session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "stopped",
        worktreePath: null,
      }),
    );

    await useSessionStore.getState().mergeWorktree("agent-1");

    expect(mergeSessionWorktree).toHaveBeenCalledWith("agent-1");
    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBeNull();
  });

  it("keeps the path when the backend refuses", async () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          status: "running",
          worktreePath: "/tmp/tree",
        }),
      ],
    });
    mergeSessionWorktree.mockRejectedValue("stop the agent first");

    await useSessionStore.getState().mergeWorktree("agent-1");

    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBe("/tmp/tree");
    expect(useSessionStore.getState().error).toContain("stop the agent first");
  });

  it("clears the path when the branch landed but teardown failed", async () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          status: "stopped",
          worktreePath: "/tmp/tree",
        }),
      ],
    });
    mergeSessionWorktree.mockRejectedValue(
      "the branch landed, but the worktree could not be removed: device busy",
    );

    await useSessionStore.getState().mergeWorktree("agent-1");

    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBeNull();
    expect(useSessionStore.getState().error).toContain("the branch landed");
  });
});

describe("toggleMaximized", () => {
  it("expands a pane and restores it on a second toggle", () => {
    const { toggleMaximized } = useSessionStore.getState();

    toggleMaximized("2");
    expect(useSessionStore.getState().maximizedPane).toBe("2");

    toggleMaximized("2");
    expect(useSessionStore.getState().maximizedPane).toBeNull();
  });
});

describe("setPaneView", () => {
  it("switches one pane to its tasks face without touching the others", () => {
    const { setPaneView } = useSessionStore.getState();

    setPaneView("1", "tasks");

    const { paneViews } = useSessionStore.getState();
    expect(paneViews["1"]).toBe("tasks");
    expect(paneViews["0"]).toBeUndefined();
  });

  it("is forgotten when another project is loaded", async () => {
    useSessionStore.getState().setPaneView("1", "graph");
    listSessions.mockResolvedValue([]);

    await useSessionStore.getState().loadSessions("p2");

    expect(useSessionStore.getState().paneViews).toEqual({});
  });
});

describe("sessionForPane", () => {
  it("finds the session occupying a pane", () => {
    const sessions = [session({ id: "a", paneId: "0" }), session({ id: "b", paneId: "3" })];

    expect(sessionForPane(sessions, "3")?.id).toBe("b");
    expect(sessionForPane(sessions, "1")).toBeUndefined();
  });
});

describe("sessionsForProject", () => {
  it("keeps only the sessions that belong to this project", () => {
    const sessions = [
      session({ id: "a", projectId: "p1" }),
      session({ id: "b", projectId: "p2", paneId: "0" }),
    ];

    expect(sessionsForProject(sessions, "p1").map((item) => item.id)).toEqual(["a"]);
    expect(sessionsForProject(sessions, "p2").map((item) => item.id)).toEqual(["b"]);
  });
});

describe("appendUpdate", () => {
  it("folds consecutive message chunks into one line", () => {
    useSessionStore.getState().appendUpdate("s1", { kind: "message", text: "Hel" });
    useSessionStore.getState().appendUpdate("s1", { kind: "message", text: "lo" });
    useSessionStore.getState().appendUpdate("s1", { kind: "tool", text: "Read src/lib.rs" });

    expect(useSessionStore.getState().transcript["s1"]).toEqual([
      { kind: "message", text: "Hello" },
      { kind: "tool", text: "Read src/lib.rs" },
    ]);
  });
});

describe("promptSession", () => {
  it("records the follow-up after the backend accepts it", async () => {
    promptSession.mockResolvedValue(undefined);

    await useSessionStore.getState().promptSession("s1", "  what leaked?  ");

    expect(promptSession).toHaveBeenCalledWith("s1", "what leaked?");
    expect(useSessionStore.getState().transcript["s1"]).toEqual([
      { kind: "prompt", text: "what leaked?" },
    ]);
  });

  it("does not record a follow-up the backend refused", async () => {
    promptSession.mockRejectedValue("that session is no longer running");

    await useSessionStore.getState().promptSession("s1", "hello");

    expect(useSessionStore.getState().transcript["s1"]).toBeUndefined();
    expect(useSessionStore.getState().error).toBe("that session is no longer running");
  });

  it("ignores an empty prompt rather than asking the backend", async () => {
    await useSessionStore.getState().promptSession("s1", "   ");
    expect(promptSession).not.toHaveBeenCalled();
  });
});

describe("cancelSession", () => {
  it("asks the backend to interrupt the turn", async () => {
    cancelSession.mockResolvedValue(undefined);

    await useSessionStore.getState().cancelSession("s1");

    expect(cancelSession).toHaveBeenCalledWith("s1");
    expect(useSessionStore.getState().error).toBeNull();
  });

  it("surfaces a failed cancel instead of throwing", async () => {
    cancelSession.mockRejectedValue("that session is no longer running");

    await useSessionStore.getState().cancelSession("s1");

    expect(useSessionStore.getState().error).toBe("that session is no longer running");
  });
});
