import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../types";

const listSessions = vi.fn();
const createSession = vi.fn();
const stopSession = vi.fn();
const restartSession = vi.fn();
const renameSession = vi.fn();
const closeSession = vi.fn();
const mergeSessionWorktree = vi.fn();
const sessionMergeReadiness = vi.fn();
const discardSessionWorktree = vi.fn();
const answerSessionPermission = vi.fn();
const promptSession = vi.fn();
const cancelSession = vi.fn();
const reopenSessionSteps = vi.fn();
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
      sessionMergeReadiness,
      answerSessionPermission,
      promptSession,
      cancelSession,
      reopenSessionSteps,
    },
  };
});

const {
  isolationNotice,
  isIsolationConfirmError,
  isPermissionMode,
  isUnisolatedAgent,
  PERMISSION_MODES,
  permissionModeFor,
  sessionForPane,
  sessionsForProject,
  UNISOLATED_REASON,
  useSessionStore,
} = await import("./sessionStore");

const ISOLATION_ERR =
  "isolation did not happen (this folder is not a git repository); confirm to start on the project tree";
const { useGraphStore } = await import("./graphStore");
const { useStepStore } = await import("./stepStore");
const { useUiStore } = await import("./uiStore");
const { BATON_ROLES, rolesInPlay } = await import("../lib/roles");
const { BATON_EXCERPT_BYTES } = await import("../lib/talkToSession");
const { matchSessionLease, resetSessionLeases } = await import("../lib/permissionLease");

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
    bytes: null,
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
const initialUiState = useUiStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  sessionMergeReadiness.mockResolvedValue(null);
  useSessionStore.getState().cancelUnisolatedStart();
  useSessionStore.setState(initialState, true);
  useGraphStore.setState(initialGraphState, true);
  useStepStore.setState(initialStepState, true);
  useUiStore.setState(initialUiState, true);
  resetSessionLeases();
});

describe("loadSessions", () => {
  it("replaces the list and drops any maximized pane from the last project", async () => {
    useUiStore.setState({ maximizedPane: "2" });
    listSessions.mockResolvedValue([session()]);

    await useSessionStore.getState().loadSessions("p1");

    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(useUiStore.getState().maximizedPane).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  it("surfaces backend errors instead of throwing", async () => {
    listSessions.mockRejectedValue("database is locked");

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().error).toBe("database is locked");
  });

  it("empties the previous project's sessions when the load fails", async () => {
    useSessionStore.setState({ sessions: [session()] });
    useUiStore.setState({
      permissions: { s1: [{ requestId: 1, summary: "Write a file" }] },
    });
    listSessions.mockRejectedValue("database is locked");

    await useSessionStore.getState().loadSessions("p2");

    const state = useSessionStore.getState();
    expect(state.sessions).toEqual([]);
    expect(useUiStore.getState().permissions).toEqual({});
  });

  it("replaces pending permissions from the arriving list", async () => {
    useSessionStore.setState({ sessions: [session({ id: "old" })] });
    useUiStore.setState({
      permissions: { old: [{ requestId: 1, summary: "Stale" }] },
    });
    listSessions.mockResolvedValue([
      session({
        id: "s1",
        pendingPermissions: [{ requestId: 9, summary: "Write a file" }],
      }),
    ]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useUiStore.getState().permissions).toEqual({
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

  it("keeps a session started while the list was in flight", async () => {
    let resolveList: (sessions: Session[]) => void = () => {};
    listSessions.mockImplementation(
      () =>
        new Promise<Session[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    createSession.mockResolvedValue(session({ id: "fresh", paneId: "0" }));

    const pending = useSessionStore.getState().loadSessions("p1");
    await useSessionStore.getState().startSession({
      projectId: "p1",
      paneId: "0",
      kind: "grok",
      cols: 80,
      rows: 24,
    });
    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual(["fresh"]);

    resolveList([]);
    await pending;

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual(["fresh"]);
    expect(useSessionStore.getState().isLoading).toBe(false);
  });

  it("folds a start into the arriving list instead of dropping the rest", async () => {
    useSessionStore.setState({ sessions: [session({ id: "keep", paneId: "0" })] });
    let resolveList: (sessions: Session[]) => void = () => {};
    listSessions.mockImplementation(
      () =>
        new Promise<Session[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    createSession.mockResolvedValue(session({ id: "fresh", paneId: "1" }));

    const pending = useSessionStore.getState().loadSessions("p1");
    await useSessionStore.getState().startSession({
      projectId: "p1",
      paneId: "1",
      kind: "grok",
      cols: 80,
      rows: 24,
    });

    resolveList([session({ id: "keep", paneId: "0" })]);
    await pending;

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      "keep",
      "fresh",
    ]);
  });

  it("lets a start displace a stale pane occupant from the snapshot", async () => {
    let resolveList: (sessions: Session[]) => void = () => {};
    listSessions.mockImplementation(
      () =>
        new Promise<Session[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    createSession.mockResolvedValue(session({ id: "fresh", paneId: "0" }));

    const pending = useSessionStore.getState().loadSessions("p1");
    await useSessionStore.getState().startSession({
      projectId: "p1",
      paneId: "0",
      kind: "grok",
      cols: 80,
      rows: 24,
    });

    resolveList([session({ id: "old", paneId: "0" })]);
    await pending;

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual(["fresh"]);
  });

  it("keeps a start when the in-flight list fails", async () => {
    let rejectList: (reason: string) => void = () => {};
    listSessions.mockImplementation(
      () =>
        new Promise<Session[]>((_, reject) => {
          rejectList = reject;
        }),
    );
    createSession.mockResolvedValue(session({ id: "fresh", projectId: "p2", paneId: "0" }));

    const pending = useSessionStore.getState().loadSessions("p2");
    await useSessionStore.getState().startSession({
      projectId: "p2",
      paneId: "0",
      kind: "grok",
      cols: 80,
      rows: 24,
    });

    rejectList("database is locked");
    await pending;

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual(["fresh"]);
    expect(useSessionStore.getState().error).toBe("database is locked");
    expect(useSessionStore.getState().isLoading).toBe(false);
  });

  it("does not fold a start for a different project into this list", async () => {
    let resolveList: (sessions: Session[]) => void = () => {};
    listSessions.mockImplementation(
      () =>
        new Promise<Session[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    createSession.mockResolvedValue(
      session({ id: "other", projectId: "p1", paneId: "0" }),
    );

    const pending = useSessionStore.getState().loadSessions("p2");
    await useSessionStore.getState().startSession({
      projectId: "p1",
      paneId: "0",
      kind: "grok",
      cols: 80,
      rows: 24,
    });

    resolveList([session({ id: "s2", projectId: "p2", paneId: "1" })]);
    await pending;

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
    await Promise.resolve();
    expect(disposeTerminal).not.toHaveBeenCalled();
    expect(detachTerminal).not.toHaveBeenCalled();
  });

  it("empties the previous project's panes before the next list arrives", async () => {
    useSessionStore.setState({ sessions: [session()] });
    useUiStore.setState({
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
    expect(useUiStore.getState().permissions).toEqual({});
    await vi.waitFor(() => expect(disposeTerminal).toHaveBeenCalledWith("s1"));
    expect(detachTerminal).not.toHaveBeenCalled();
    expect(useGraphStore.getState().bySession).toEqual({});
    // The conversation is still running; coming back should not start from blank.
    expect(useUiStore.getState().transcript["s1"]?.[0]?.text).toBe("hello");

    resolveNext([session({ id: "s2", projectId: "p2" })]);
    await pending;

    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual(["s2"]);
    expect(useUiStore.getState().transcript["s1"]?.[0]?.text).toBe("hello");
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
    await Promise.resolve();
    expect(disposeTerminal).not.toHaveBeenCalled();
    expect(detachTerminal).not.toHaveBeenCalled();

    resolveList([session()]);
    await pending;
  });

  it("drops transcripts of sessions that disappeared from the same project", async () => {
    useSessionStore.setState({
      sessions: [session(), session({ id: "s2", paneId: "1" })],
    });
    useUiStore.setState({
      transcript: {
        s1: [{ kind: "message", text: "keep" }],
        s2: [{ kind: "message", text: "gone" }],
      },
    });
    listSessions.mockResolvedValue([session()]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useUiStore.getState().transcript).toEqual({
      s1: [{ kind: "message", text: "keep" }],
    });
    await Promise.resolve();
    expect(disposeTerminal).not.toHaveBeenCalled();
    expect(detachTerminal).not.toHaveBeenCalled();
  });

  it("drops a stopped session's transcript when leaving the project", async () => {
    useSessionStore.setState({ sessions: [session({ status: "stopped" })] });
    useUiStore.setState({ transcript: { s1: [{ kind: "message", text: "old run" }] } });
    listSessions.mockResolvedValue([session({ id: "s2", projectId: "p2" })]);

    await useSessionStore.getState().loadSessions("p2");

    expect(useUiStore.getState().transcript["s1"]).toBeUndefined();
    await vi.waitFor(() => expect(disposeTerminal).toHaveBeenCalledWith("s1"));
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
    useUiStore.setState({ paneViews: { "0": "graph" } });
    createSession.mockResolvedValue(session());

    await useSessionStore
      .getState()
      .startSession({ projectId: "p1", paneId: "0", kind: "grok", cols: 80, rows: 24 });

    expect(useUiStore.getState().paneViews["0"]).toBe("terminal");
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

  it("does not send allowUnisolated on a start that isolated", async () => {
    createSession.mockResolvedValue(
      session({ id: "a1", kind: "agent", paneId: null, worktreePath: "/wt" }),
    );

    await useSessionStore.getState().startSession({
      projectId: "p1",
      paneId: null,
      kind: "agent",
      cols: 80,
      rows: 24,
    });

    expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("allowUnisolated");
    expect(useSessionStore.getState().isolationConfirm).toBeNull();
  });

  it("opens confirm on the isolation error and retries only after Start", async () => {
    createSession.mockRejectedValueOnce(ISOLATION_ERR).mockResolvedValueOnce(
      session({
        id: "a1",
        kind: "agent",
        paneId: null,
        status: "idle",
        worktreePath: null,
        isolationSkip: "this folder is not a git repository",
      }),
    );

    const pending = useSessionStore.getState().startSession({
      projectId: "p1",
      paneId: null,
      kind: "agent",
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(() =>
      expect(useSessionStore.getState().isolationConfirm?.message).toBe(ISOLATION_ERR),
    );
    expect(useSessionStore.getState().error).toBeNull();
    expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("allowUnisolated");

    useSessionStore.getState().confirmUnisolatedStart();
    expect(await pending).toMatchObject({ id: "a1" });
    expect(createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ allowUnisolated: true }),
    );
    expect(useSessionStore.getState().isolationReasons["a1"]).toBe(
      "this folder is not a git repository",
    );
  });

  it("leaves the agent unstarted when confirm is cancelled", async () => {
    createSession.mockRejectedValue(ISOLATION_ERR);

    const pending = useSessionStore.getState().startSession({
      projectId: "p1",
      paneId: null,
      kind: "agent",
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(() => expect(useSessionStore.getState().isolationConfirm).not.toBeNull());
    useSessionStore.getState().cancelUnisolatedStart();

    expect(await pending).toBeNull();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().error).toBeNull();
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

  it("still records stopped on a live agent", () => {
    useSessionStore.setState({
      sessions: [session({ kind: "agent", paneId: null, status: "idle" })],
    });

    useSessionStore.getState().markStatus("s1", "stopped");

    expect(useSessionStore.getState().sessions[0]?.status).toBe("stopped");
  });

  it("ignores a late non-stopped status on a session that has already stopped", () => {
    useSessionStore.setState({
      sessions: [
        session({ kind: "agent", paneId: null, status: "stopped", processId: null, exitCode: 0 }),
      ],
    });

    useSessionStore.getState().markStatus("s1", "idle");

    expect(useSessionStore.getState().sessions[0]?.status).toBe("stopped");
  });

  it("does not invent a row for a status event whose session has left the list", () => {
    useSessionStore.setState({ sessions: [] });

    useSessionStore.getState().markStatus("gone", "idle");

    expect(useSessionStore.getState().sessions).toEqual([]);
  });
});

describe("permissions", () => {
  const asked = { requestId: 9, summary: "Run `git push`" };

    it("keeps one per request, since an agent can be blocked on several", () => {
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useSessionStore.getState().askPermission("s1", asked);
    useSessionStore.getState().askPermission("s1", { requestId: 10, summary: "Write a file" });

    expect(useUiStore.getState().permissions["s1"]).toHaveLength(2);
  });

  it("upserts a late session-permission so the same requestId cannot stack", async () => {
    listSessions.mockResolvedValue([
      session({
        id: "s1",
        kind: "agent",
        paneId: null,
        pendingPermissions: [{ requestId: 9, summary: "Run `git push`" }],
      }),
    ]);
    await useSessionStore.getState().loadSessions("p1");

    useSessionStore.getState().askPermission("s1", {
      requestId: 9,
      summary: "Run `git push` (again)",
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    });
    useSessionStore.getState().askPermission("s1", {
      requestId: 9,
      summary: "Run `git push` (latest)",
    });
    useSessionStore.getState().askPermission("s1", { requestId: 10, summary: "Write a file" });

    expect(useUiStore.getState().permissions["s1"]).toEqual([
      { requestId: 9, summary: "Run `git push` (latest)" },
      { requestId: 10, summary: "Write a file" },
    ]);
  });

  it("drops only the one that was answered", async () => {
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useSessionStore.getState().askPermission("s1", asked);
    useSessionStore.getState().askPermission("s1", { requestId: 10, summary: "Write a file" });
    answerSessionPermission.mockResolvedValue(undefined);

    await useSessionStore.getState().answerPermission("s1", 9, true);

    expect(answerSessionPermission).toHaveBeenCalledWith("s1", 9, true, undefined);
    expect(useUiStore.getState().permissions["s1"]?.map((p) => p.requestId)).toEqual([10]);
  });

  it("forwards an explicit option id so Always allow is not smuggled through Allow", async () => {
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useSessionStore.getState().askPermission("s1", asked);
    answerSessionPermission.mockResolvedValue(undefined);

    await useSessionStore.getState().answerPermission("s1", 9, true, "allow-always");

    expect(answerSessionPermission).toHaveBeenCalledWith("s1", 9, true, "allow-always");
  });

  it("leaves the question standing when the answer could not be sent", async () => {
    // The agent is still waiting either way, so the buttons have to stay.
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useSessionStore.getState().askPermission("s1", asked);
    answerSessionPermission.mockRejectedValue("that session is no longer running");

    await useSessionStore.getState().answerPermission("s1", 9, true);

    expect(useUiStore.getState().permissions["s1"]).toHaveLength(1);
    expect(useSessionStore.getState().error).toBe("that session is no longer running");
  });

  it("forgets what a session that has gone was asking", () => {
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useSessionStore.getState().askPermission("s1", asked);

    useSessionStore.getState().markExited("s1", null);

    expect(useUiStore.getState().permissions["s1"]).toBeUndefined();
  });

  it("ignores a prompt for a session that is not in the list", () => {
    useSessionStore.getState().askPermission("gone", asked);

    expect(useUiStore.getState().permissions["gone"]).toBeUndefined();
  });
});

describe("permission mode", () => {
  const once = {
    optionId: "allow-once",
    name: "Allow once",
    kind: "allow_once" as const,
  };

  it("is plan | ask | acceptEdits, with no yolo", () => {
    expect(PERMISSION_MODES).toEqual(["plan", "ask", "acceptEdits"]);
    expect(isPermissionMode("yolo")).toBe(false);
    expect(isPermissionMode("bypassPermissions")).toBe(false);
    expect(isPermissionMode("plan")).toBe(true);
  });

  it("maps Spec (proposed) to plan and other phases to ask", () => {
    expect(permissionModeFor("proposed", undefined)).toBe("plan");
    expect(permissionModeFor("approved", undefined)).toBe("ask");
    expect(permissionModeFor("none", undefined)).toBe("ask");
    expect(permissionModeFor("proposed", "ask")).toBe("ask");
    expect(permissionModeFor("none", "acceptEdits")).toBe("acceptEdits");
  });

  it("rejects yolo and does not record it", async () => {
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });

    await useSessionStore.getState().setPermissionMode("s1", "yolo" as never);

    expect(useSessionStore.getState().permissionModes["s1"]).toBeUndefined();
  });

  it("plan reopens an approved list (Spec)", async () => {
    useSessionStore.setState({ sessions: [session({ kind: "agent", paneId: null })] });
    useStepStore.setState({
      bySession: { s1: { ...stepEntry(), phase: "approved" } },
    });
    reopenSessionSteps.mockResolvedValue({
      sessionId: "s1",
      phase: "proposed",
      steps: stepEntry().steps,
    });

    await useSessionStore.getState().setPermissionMode("s1", "plan");

    expect(useSessionStore.getState().permissionModes["s1"]).toBe("plan");
    expect(reopenSessionSteps).toHaveBeenCalledWith("s1");
    expect(useStepStore.getState().bySession["s1"]?.phase).toBe("proposed");
  });

  it("acceptEdits auto-answers edit-class as allow_once and grants a lease", async () => {
    useSessionStore.setState({
      sessions: [session({ kind: "agent", paneId: null })],
      permissionModes: { s1: "acceptEdits" },
    });
    answerSessionPermission.mockResolvedValue(undefined);

    useSessionStore.getState().askPermission("s1", {
      requestId: 9,
      summary: "Edit src/auth.ts",
      options: [once, { optionId: "reject", name: "Reject", kind: "reject_once" }],
    });

    await vi.waitFor(() => {
      expect(answerSessionPermission).toHaveBeenCalledWith("s1", 9, true);
    });
    expect(answerSessionPermission.mock.calls[0]?.[3]).toBeUndefined();
    expect(useUiStore.getState().permissions["s1"]).toBeUndefined();
    expect(matchSessionLease("s1", "Edit src/lib/permissions.ts")?.prefix).toBe("src/");
  });

  it("acceptEdits does not auto-allow a Reviewer project-tree write", () => {
    useSessionStore.setState({
      sessions: [session({ kind: "agent", paneId: null, role: "Reviewer" })],
      permissionModes: { s1: "acceptEdits" },
    });

    useSessionStore.getState().askPermission("s1", {
      requestId: 9,
      summary: "Edit src/auth.ts",
      options: [once, { optionId: "reject", name: "Reject", kind: "reject_once" }],
    });

    expect(answerSessionPermission).not.toHaveBeenCalled();
    expect(useUiStore.getState().permissions["s1"]?.map((item) => item.requestId)).toEqual([9]);
  });

  it("acceptEdits still asks for Bash and Read", () => {
    useSessionStore.setState({
      sessions: [session({ kind: "agent", paneId: null })],
      permissionModes: { s1: "acceptEdits" },
    });

    useSessionStore.getState().askPermission("s1", {
      requestId: 9,
      summary: "Bash npm test",
      options: [once],
    });
    useSessionStore.getState().askPermission("s1", {
      requestId: 10,
      summary: "Read src/auth.ts",
      options: [once],
    });

    expect(answerSessionPermission).not.toHaveBeenCalled();
    expect(useUiStore.getState().permissions["s1"]?.map((item) => item.requestId)).toEqual([
      9, 10,
    ]);
  });

  it("does not pass the mode into createSession", async () => {
    createSession.mockResolvedValue(session({ kind: "agent", paneId: null }));

    await useSessionStore.getState().startSession({
      projectId: "p1",
      paneId: null,
      kind: "agent",
      cols: 80,
      rows: 24,
    });

    expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("permissionMode");
  });

  it("drops the mode on Stop and Restart (new id)", async () => {
    useSessionStore.setState({
      sessions: [session({ kind: "agent", paneId: null })],
      permissionModes: { s1: "acceptEdits" },
    });

    useSessionStore.getState().markExited("s1", null);
    expect(useSessionStore.getState().permissionModes["s1"]).toBeUndefined();

    useSessionStore.setState({
      sessions: [session({ kind: "agent", paneId: null })],
      permissionModes: { s1: "acceptEdits" },
    });
    restartSession.mockResolvedValue(session({ id: "s2", kind: "agent", paneId: null }));

    await useSessionStore.getState().restartSession("s1", 80, 24);

    expect(useSessionStore.getState().permissionModes).toEqual({});
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
    expect(useUiStore.getState().paneViews).toEqual({});
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
    expect(promptSession).toHaveBeenCalledWith("s-Planner", expect.stringContaining("planner"));
    // The memory is named in every brief, since the file always exists for a session
    // GrokSpace started.
    expect(promptSession).toHaveBeenCalledWith(
      "s-Reviewer",
      expect.stringContaining("GROKSPACE_MEMORY_FILE"),
    );
  });

  it("starts a later role before an earlier start finishes", async () => {
    let releasePlanner: (value: Session) => void = () => {};
    createSession.mockImplementation((input: { role?: string }) => {
      if (input.role === "Planner") {
        return new Promise<Session>((resolve) => {
          releasePlanner = resolve;
        });
      }
      return Promise.resolve(session({ id: "s-reviewer", kind: "agent", paneId: null }));
    });
    promptSession.mockResolvedValue(undefined);

    const pending = useSessionStore.getState().launchSwarm("p1", roles);
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    releasePlanner(session({ id: "s-planner", kind: "agent", paneId: null }));
    const failed = await pending;

    expect(failed).toEqual([]);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ role: "Reviewer" }));
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
    // A later successful start must not wipe the banner that named the failure.
    expect(useSessionStore.getState().error).toBe("Planner: could not find `grok` on PATH");
  });

  it("counts a session that started but could not be briefed as failed", async () => {
    // Worse than not starting: it would sit there looking ready and knowing nothing.
    createSession.mockResolvedValue(session({ id: "s-planner", kind: "agent", paneId: null }));
    promptSession.mockRejectedValue("that session is no longer running");
    closeSession.mockResolvedValue(undefined);

    const failed = await useSessionStore.getState().launchSwarm("p1", [roles[0]!]);

    expect(failed).toEqual(["Planner"]);
    expect(closeSession).toHaveBeenCalledWith("s-planner");
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().error).toBe("Planner: that session is no longer running");
  });

  it("joins every failed role onto one banner so a later start cannot hide the first", async () => {
    createSession.mockImplementation((input: { role?: string }) =>
      input.role === "Planner"
        ? Promise.reject("could not find `grok` on PATH")
        : Promise.resolve(session({ id: `s-${input.role}`, kind: "agent", paneId: null })),
    );
    promptSession.mockImplementation((id: string) =>
      id === "s-Reviewer"
        ? Promise.reject("that session is no longer running")
        : Promise.resolve(undefined),
    );
    closeSession.mockResolvedValue(undefined);

    const failed = await useSessionStore.getState().launchSwarm("p1", roles);

    expect(failed).toEqual(["Planner", "Reviewer"]);
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().error).toBe(
      "Planner: could not find `grok` on PATH · Reviewer: that session is no longer running",
    );
  });

  it("confirms isolation once for the swarm and retries with the flag", async () => {
    createSession.mockImplementation((input: { allowUnisolated?: boolean; role?: string }) =>
      input.allowUnisolated === true
        ? Promise.resolve(
            session({
              id: `s-${input.role ?? "?"}`,
              kind: "agent",
              paneId: null,
              status: "idle",
              worktreePath: null,
              isolationSkip: "this folder is not a git repository",
            }),
          )
        : Promise.reject(ISOLATION_ERR),
    );
    promptSession.mockResolvedValue(undefined);

    const pending = useSessionStore.getState().launchSwarm("p1", roles);
    await vi.waitFor(() => expect(useSessionStore.getState().isolationConfirm).not.toBeNull());
    expect(useSessionStore.getState().error).toBeNull();
    useSessionStore.getState().confirmUnisolatedStart();

    expect(await pending).toEqual([]);
    expect(createSession.mock.calls.some((call) => call[0]?.allowUnisolated === true)).toBe(true);
    expect(useSessionStore.getState().isolationReasons["s-Planner"]).toBe(
      "this folder is not a git repository",
    );
  });

  it("does not start unisolated roles when the swarm confirm is cancelled", async () => {
    createSession.mockRejectedValue(ISOLATION_ERR);

    const pending = useSessionStore.getState().launchSwarm("p1", roles);
    await vi.waitFor(() => expect(useSessionStore.getState().isolationConfirm).not.toBeNull());
    useSessionStore.getState().cancelUnisolatedStart();

    expect(await pending).toEqual(["Planner", "Reviewer"]);
    expect(createSession.mock.calls.every((call) => call[0]?.allowUnisolated !== true)).toBe(true);
    expect(useSessionStore.getState().error).toBeNull();
  });
});

describe("handToRole", () => {
  const coder = BATON_ROLES.find((role) => role.name === "Coder")!;
  const planner = (status: Session["status"] = "running") =>
    session({
      id: "planner-1",
      kind: "agent",
      paneId: null,
      role: "Planner",
      title: "Planner",
      status,
    });
  const startedCoder = () =>
    session({ id: "coder-1", kind: "agent", paneId: null, role: "Coder", status: "idle" });

  it("starts Coder with memory, the source graph path, approved titles, and a capped excerpt", async () => {
    const head = "SECRET-HEAD-";
    const body = "n".repeat(BATON_EXCERPT_BYTES);
    useSessionStore.setState({ sessions: [planner()] });
    useUiStore.setState({
      transcript: {
        "planner-1": [
          { kind: "message", text: head + body },
          { kind: "message", text: "recent-tail" },
        ],
      },
    });
    useGraphStore.setState({
      bySession: { "planner-1": { ...graphEntry(), path: "/p/.grokspace/graphs/planner-1.json" } },
    });
    useStepStore.setState({
      bySession: {
        "planner-1": {
          ...stepEntry(),
          sessionId: "planner-1",
          phase: "approved",
          steps: [{ ...stepEntry().steps[0]!, title: "Ship the gate" }],
        },
      },
    });
    createSession.mockResolvedValue(startedCoder());
    promptSession.mockResolvedValue(undefined);

    const ok = await useSessionStore.getState().handToRole("planner-1", coder, "/p");
    const sent = promptSession.mock.calls[0]?.[1] as string;

    expect(ok).toBe(true);
    expect(cancelSession).toHaveBeenCalledWith("planner-1");
    expect(closeSession).not.toHaveBeenCalledWith("planner-1");
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: null, kind: "agent", role: "Coder" }),
    );
    expect(createSession.mock.calls[0]?.[0]?.allowUnisolated).toBeUndefined();
    expect(sent).toContain("$GROKSPACE_MEMORY_FILE");
    expect(sent).toContain("/p/.grokspace/graphs/planner-1.json");
    expect(sent).toContain("read-only");
    expect(sent).toContain("1. Ship the gate");
    expect(sent).toContain("recent-tail");
    expect(sent).not.toContain(head);
    expect(sent).not.toContain(`${head}${body} recent-tail`);
    expect([...rolesInPlay(useSessionStore.getState().sessions)].sort()).toEqual([
      "Coder",
      "Planner",
    ]);
  });

  it("prompts an idle Coder instead of starting another", async () => {
    useSessionStore.setState({
      sessions: [planner("idle"), startedCoder()],
    });
    promptSession.mockResolvedValue(undefined);

    const ok = await useSessionStore.getState().handToRole("planner-1", coder, "/p");

    expect(ok).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    expect(cancelSession).not.toHaveBeenCalled();
    expect(promptSession).toHaveBeenCalledWith("coder-1", expect.stringContaining("read-only"));
    expect(rolesInPlay(useSessionStore.getState().sessions).has("Coder")).toBe(true);
  });

  it("closes a new Coder that started but could not be briefed, and leaves the source", async () => {
    useSessionStore.setState({ sessions: [planner("idle")] });
    createSession.mockResolvedValue(startedCoder());
    promptSession.mockRejectedValue("that session is no longer running");
    closeSession.mockResolvedValue(undefined);

    const ok = await useSessionStore.getState().handToRole("planner-1", coder, "/p");

    expect(ok).toBe(false);
    expect(closeSession).toHaveBeenCalledWith("coder-1");
    expect(closeSession).not.toHaveBeenCalledWith("planner-1");
    expect(useSessionStore.getState().sessions.map((row) => row.id)).toEqual(["planner-1"]);
    expect(useSessionStore.getState().error).toBe("Coder: that session is no longer running");
    expect(rolesInPlay(useSessionStore.getState().sessions).has("Coder")).toBe(false);
  });

  it("does not paste proposed step titles", async () => {
    useSessionStore.setState({ sessions: [planner("idle")] });
    useStepStore.setState({
      bySession: { "planner-1": { ...stepEntry(), sessionId: "planner-1", phase: "proposed" } },
    });
    createSession.mockResolvedValue(startedCoder());
    promptSession.mockResolvedValue(undefined);

    await useSessionStore.getState().handToRole("planner-1", coder, "/p");

    expect(promptSession.mock.calls[0]?.[1]).not.toContain("Approved steps");
    expect(promptSession.mock.calls[0]?.[1]).not.toContain("Read it");
  });
});

describe("restartSession", () => {
  it("swaps in the new session and disposes the old terminal", async () => {
    useSessionStore.setState({ sessions: [session({ id: "old", paneId: "1" })] });
    useUiStore.setState({ transcript: { old: [{ kind: "message", text: "previous run" }] } });
    restartSession.mockResolvedValue(session({ id: "fresh", paneId: "1" }));

    await useSessionStore.getState().restartSession("old", 100, 30);

    expect(restartSession).toHaveBeenCalledWith("old", 100, 30);
    // Restarting mints a new id, so the old xterm instance has to go.
    await vi.waitFor(() => expect(disposeTerminal).toHaveBeenCalledWith("old"));
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["fresh"]);
    expect(useUiStore.getState().transcript["old"]).toBeUndefined();
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

describe("continueJob", () => {
  const tree = "/tmp/acme/.grokspace/worktrees/old";
  const stopped = () =>
    session({
      id: "old",
      kind: "agent",
      paneId: null,
      title: "Coder",
      role: "Coder",
      status: "stopped",
      worktreePath: tree,
    });
  const fresh = () =>
    session({
      id: "fresh",
      kind: "agent",
      paneId: null,
      title: "Coder",
      role: "Coder",
      status: "idle",
      worktreePath: tree,
    });

  it("mints a new id on the same worktree and briefs graph, steps, and a capped excerpt", async () => {
    const head = "SECRET-HEAD-";
    const body = "n".repeat(BATON_EXCERPT_BYTES);
    useSessionStore.setState({ sessions: [stopped()] });
    useUiStore.setState({
      transcript: {
        old: [
          { kind: "message", text: head + body },
          { kind: "message", text: "recent-tail" },
        ],
      },
    });
    useGraphStore.setState({
      bySession: { old: { ...graphEntry(), path: "/p/.grokspace/graphs/old.json" } },
    });
    useStepStore.setState({
      bySession: {
        old: {
          ...stepEntry(),
          sessionId: "old",
          phase: "proposed",
          steps: [{ ...stepEntry().steps[0]!, title: "Ship the gate" }],
        },
      },
    });
    restartSession.mockResolvedValue(fresh());
    promptSession.mockResolvedValue(undefined);

    const next = await useSessionStore.getState().continueJob("old", 80, 24, "/p");
    const sent = promptSession.mock.calls[0]?.[1] as string;

    expect(next?.id).toBe("fresh");
    expect(next?.worktreePath).toBe(tree);
    expect(restartSession).toHaveBeenCalledWith("old", 80, 24);
    expect(createSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions.map((row) => row.id)).toEqual(["fresh"]);
    expect(useUiStore.getState().transcript["old"]).toBeUndefined();
    expect(sent).toContain("$GROKSPACE_MEMORY_FILE");
    expect(sent).toContain("/p/.grokspace/graphs/old.json");
    expect(sent).toContain("1. Ship the gate");
    expect(sent).toContain("recent-tail");
    expect(sent).not.toContain("--resume");
    expect(sent).not.toContain(head);
    expect(sent).not.toContain(`${head}${body} recent-tail`);
  });

  it("does not prompt when Restart fails, and leaves a new row if the brief fails", async () => {
    useSessionStore.setState({ sessions: [stopped()] });
    restartSession.mockRejectedValue("could not find `grok` on PATH");

    expect(await useSessionStore.getState().continueJob("old", 80, 24, "/p")).toBeNull();
    expect(promptSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().error).toContain("could not find `grok`");

    restartSession.mockResolvedValue(fresh());
    promptSession.mockRejectedValue("that session is no longer running");
    useSessionStore.setState({ sessions: [stopped()], error: null });

    const next = await useSessionStore.getState().continueJob("old", 80, 24, "/p");

    expect(next?.id).toBe("fresh");
    expect(closeSession).not.toHaveBeenCalledWith("fresh");
    expect(useSessionStore.getState().sessions.map((row) => row.id)).toEqual(["fresh"]);
    expect(useSessionStore.getState().error).toBe("that session is no longer running");
  });

  it("refuses a terminal", async () => {
    useSessionStore.setState({ sessions: [session({ id: "term", kind: "grok" })] });

    expect(await useSessionStore.getState().continueJob("term", 80, 24, "/p")).toBeNull();
    expect(restartSession).not.toHaveBeenCalled();
    expect(promptSession).not.toHaveBeenCalled();
  });
});

describe("forkFromNode", () => {
  const tree = "/tmp/acme/.grokspace/worktrees/old";
  const parent = () =>
    session({
      id: "old",
      kind: "agent",
      paneId: null,
      role: "Coder",
      status: "running",
      worktreePath: tree,
    });
  const plan = {
    id: "g1",
    name: "Plan",
    status: "running" as const,
    nodes: [
      { id: "a", type: "orchestrator" as const, label: "A", status: "completed" as const, position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "agent" as const, label: "B", status: "failed" as const, position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [{ id: "e1", source: "a", target: "b", type: "smoothstep" as const, animated: false }],
  };

  it("starts a new isolated session, remints graph ids, and leaves the parent listed", async () => {
    useSessionStore.setState({ sessions: [parent()] });
    useGraphStore.setState({ bySession: { old: { ...graphEntry(), graph: plan } } });
    useStepStore.setState({
      bySession: {
        old: {
          ...stepEntry(),
          sessionId: "old",
          phase: "approved",
          steps: [{ ...stepEntry().steps[0]!, title: "Ship the gate", status: "done" }],
        },
      },
    });
    createSession.mockResolvedValue(
      session({ id: "fresh", kind: "agent", paneId: null, worktreePath: `${tree}-fresh` }),
    );

    const next = await useSessionStore.getState().forkFromNode("old", "a");
    const sent = createSession.mock.calls[0]?.[0] as { seedGraph?: string; seedSteps?: string };
    const seeded = JSON.parse(sent.seedGraph ?? "{}") as { nodes: { id: string; status: string }[] };

    expect(next?.id).toBe("fresh");
    expect(next?.worktreePath).not.toBe(tree);
    expect(restartSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", paneId: null, kind: "agent", role: "Coder" }),
    );
    expect(sent).not.toHaveProperty("reuseWorktree");
    expect(seeded.nodes.map((node) => node.id)).not.toEqual(["a", "b"]);
    expect(seeded.nodes.map((node) => node.status)).toEqual(["running", "pending"]);
    expect(JSON.parse(sent.seedSteps ?? "{}")).toEqual({
      steps: [{ title: "Ship the gate", status: "pending" }],
    });
    expect(useSessionStore.getState().sessions.map((row) => row.id)).toEqual(["old", "fresh"]);
    expect(useGraphStore.getState().bySession.old?.graph).toEqual(plan);
  });

  it("does not start when the graph is missing or the node is", async () => {
    useSessionStore.setState({ sessions: [parent()] });
    useGraphStore.setState({ bySession: { old: graphEntry() } });
    expect(await useSessionStore.getState().forkFromNode("old", "a")).toBeNull();
    expect(createSession).not.toHaveBeenCalled();

    useGraphStore.setState({ bySession: { old: { ...graphEntry(), graph: plan } } });
    expect(await useSessionStore.getState().forkFromNode("old", "missing")).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions.map((row) => row.id)).toEqual(["old"]);
  });
});

describe("closeSession", () => {
  it("frees the pane and disposes the terminal", async () => {
    useSessionStore.setState({
      sessions: [session(), session({ id: "s2", paneId: "1" })],
    });
    useUiStore.setState({
      transcript: { s1: [{ kind: "message", text: "hello" }], s2: [{ kind: "tool", text: "Read" }] },
    });
    closeSession.mockResolvedValue(undefined);

    await useSessionStore.getState().closeSession("s1");

    await vi.waitFor(() => expect(disposeTerminal).toHaveBeenCalledWith("s1"));
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(useUiStore.getState().transcript["s1"]).toBeUndefined();
    expect(useUiStore.getState().transcript["s2"]?.[0]?.text).toBe("Read");
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
    await Promise.resolve();
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
  it("writes a readiness refusal onto the strip and does not invoke merge", async () => {
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
    sessionMergeReadiness.mockResolvedValue("nothing to merge");

    await useSessionStore.getState().mergeWorktree("agent-1");

    expect(sessionMergeReadiness).toHaveBeenCalledWith("agent-1");
    expect(mergeSessionWorktree).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBe("/tmp/tree");
    expect(useSessionStore.getState().mergeReasons["agent-1"]).toBe("nothing to merge");
    expect(useSessionStore.getState().error).toBeNull();
  });

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
      mergeReasons: { "agent-1": "nothing to merge" },
    });
    mergeSessionWorktree.mockResolvedValue({
      session: session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "stopped",
        worktreePath: null,
      }),
    });

    await useSessionStore.getState().mergeWorktree("agent-1");

    expect(mergeSessionWorktree).toHaveBeenCalledWith("agent-1");
    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBeNull();
    expect(useSessionStore.getState().mergeReasons["agent-1"]).toBeUndefined();
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
    expect(useSessionStore.getState().mergeReasons["agent-1"]).toContain(
      "stop the agent first",
    );
  });

  it("writes a conflict abort onto the reason field", async () => {
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
      mergeReasons: { "agent-1": null },
    });
    mergeSessionWorktree.mockRejectedValue(
      "git could not merge the agent's branch — the merge was aborted",
    );

    await useSessionStore.getState().mergeWorktree("agent-1");

    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBe("/tmp/tree");
    expect(useSessionStore.getState().mergeReasons["agent-1"]).toContain(
      "the merge was aborted",
    );
    expect(useSessionStore.getState().error).toContain("the merge was aborted");
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
      mergeReasons: { "agent-1": null },
    });
    mergeSessionWorktree.mockResolvedValue({
      session: session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "stopped",
        worktreePath: null,
      }),
      teardownError: "device busy",
    });

    await useSessionStore.getState().mergeWorktree("agent-1");

    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBeNull();
    expect(useSessionStore.getState().error).toContain("device busy");
    expect(useSessionStore.getState().mergeReasons["agent-1"]).toBeUndefined();
  });
});

describe("inspectMerge", () => {
  it("stores the reason the backend reports", async () => {
    sessionMergeReadiness.mockResolvedValue("commit or stash the project first");

    await useSessionStore.getState().inspectMerge("agent-1");

    expect(sessionMergeReadiness).toHaveBeenCalledWith("agent-1");
    expect(useSessionStore.getState().mergeReasons["agent-1"]).toBe(
      "commit or stash the project first",
    );
  });

  it("stores null when leftover commit and merge may run", async () => {
    sessionMergeReadiness.mockResolvedValue(null);

    await useSessionStore.getState().inspectMerge("agent-1");

    expect(useSessionStore.getState().mergeReasons["agent-1"]).toBeNull();
  });

  it("writes a thrown inspect onto the reason field rather than the toast", async () => {
    sessionMergeReadiness.mockRejectedValue("no session found with id agent-1");

    await useSessionStore.getState().inspectMerge("agent-1");

    expect(useSessionStore.getState().mergeReasons["agent-1"]).toBe(
      "no session found with id agent-1",
    );
    expect(useSessionStore.getState().error).toBeNull();
  });
});

describe("setPaneView", () => {
  it("is forgotten when another project is loaded", async () => {
    useUiStore.getState().setPaneView("1", "graph");
    listSessions.mockResolvedValue([]);

    await useSessionStore.getState().loadSessions("p2");

    expect(useUiStore.getState().paneViews).toEqual({});
  });
});

describe("sessionForPane", () => {
  it("finds the session occupying a pane", () => {
    const sessions = [session({ id: "a", paneId: "0" }), session({ id: "b", paneId: "3" })];

    expect(sessionForPane(sessions, "3")?.id).toBe("b");
    expect(sessionForPane(sessions, "1")).toBeUndefined();
  });

  it("keeps other pane session objects when one status changes", () => {
    const first = session({ id: "a", paneId: "0" });
    const second = session({ id: "b", paneId: "1" });
    useSessionStore.setState({ sessions: [first, second] });

    useSessionStore.getState().markStatus("a", "idle");

    const next = useSessionStore.getState().sessions;
    expect(next.find((item) => item.id === "b")).toBe(second);
    expect(next.find((item) => item.id === "a")).not.toBe(first);
  });
});

describe("isUnisolatedAgent", () => {
  it("is a live agent with no worktree", () => {
    expect(
      isUnisolatedAgent(
        session({ kind: "agent", paneId: null, status: "idle", worktreePath: null }),
      ),
    ).toBe(true);
    expect(
      isUnisolatedAgent(
        session({ kind: "agent", paneId: null, status: "running", worktreePath: null }),
      ),
    ).toBe(true);
    expect(
      isUnisolatedAgent(
        session({
          kind: "agent",
          paneId: null,
          status: "needs_input",
          worktreePath: null,
        }),
      ),
    ).toBe(true);
  });

  it("is not a grok pane, even with no worktree", () => {
    expect(isUnisolatedAgent(session({ kind: "grok", worktreePath: null }))).toBe(false);
  });

  it("is not an isolated agent", () => {
    expect(
      isUnisolatedAgent(
        session({ kind: "agent", paneId: null, worktreePath: "/tmp/tree" }),
      ),
    ).toBe(false);
  });

  it("is not a stopped agent, even with no worktree", () => {
    expect(
      isUnisolatedAgent(
        session({
          kind: "agent",
          paneId: null,
          status: "stopped",
          worktreePath: null,
        }),
      ),
    ).toBe(false);
  });
});

describe("isIsolationConfirmError", () => {
  it("matches the Rust fail-closed sentence and nothing else", () => {
    expect(isIsolationConfirmError(ISOLATION_ERR)).toBe(true);
    expect(isIsolationConfirmError("could not find `grok` on PATH")).toBe(false);
    expect(isIsolationConfirmError(UNISOLATED_REASON)).toBe(false);
  });
});

describe("isolationNotice", () => {
  it("says isolation did not happen and the agent is on the project tree", () => {
    expect(
      isolationNotice(session({ kind: "agent", paneId: null, title: "Reviewer" })),
    ).toBe("Reviewer is not isolated. Isolation did not happen, so this agent is on the project tree.");
  });

  it("names the skip when the live reason has arrived", () => {
    expect(
      isolationNotice(
        session({ kind: "agent", paneId: null, title: "Reviewer" }),
        "this folder is not a git repository",
      ),
    ).toBe(
      "Reviewer is not isolated. Isolation did not happen (this folder is not a git repository), so this agent is on the project tree.",
    );
  });
});

describe("isolationReasons", () => {
  it("flags an agent that started without a worktree", async () => {
    createSession.mockResolvedValue(
      session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "idle",
        worktreePath: null,
        title: "Reviewer",
      }),
    );

    await useSessionStore.getState().startSession({
      projectId: "p1",
      paneId: null,
      kind: "agent",
      cols: 80,
      rows: 24,
    });

    expect(useSessionStore.getState().isolationReasons["agent-1"]).toBe(UNISOLATED_REASON);
  });

  it("uses a persisted skip reason after reload, without a live event", async () => {
    listSessions.mockResolvedValue([
      session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "idle",
        worktreePath: null,
        title: "Reviewer",
        isolationSkip: "this folder is not a git repository",
      }),
    ]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().isolationReasons["agent-1"]).toBe(
      "this folder is not a git repository",
    );
  });

  it("flags a live agent with no worktree after reload, without a live event", async () => {
    listSessions.mockResolvedValue([
      session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "idle",
        worktreePath: null,
        title: "Reviewer",
      }),
    ]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().isolationReasons["agent-1"]).toBe(UNISOLATED_REASON);
  });

  it("does not flag a stopped agent after reload", async () => {
    listSessions.mockResolvedValue([
      session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "stopped",
        worktreePath: null,
        title: "Reviewer",
      }),
    ]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().isolationReasons).toEqual({});
  });

  it("keeps a live skip reason across reload", async () => {
    useSessionStore.getState().noteIsolation("agent-1", "this folder is not a git repository");
    listSessions.mockResolvedValue([
      session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "idle",
        worktreePath: null,
        title: "Reviewer",
      }),
    ]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().isolationReasons["agent-1"]).toBe(
      "this folder is not a git repository",
    );
  });

  it("does not flag a grok pane", async () => {
    listSessions.mockResolvedValue([session()]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().isolationReasons).toEqual({});
  });

  it("does not flag an isolated agent", async () => {
    listSessions.mockResolvedValue([
      session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        worktreePath: "/tmp/tree",
      }),
    ]);

    await useSessionStore.getState().loadSessions("p1");

    expect(useSessionStore.getState().isolationReasons).toEqual({});
  });

  it("drops the reason when the session is closed", async () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          worktreePath: null,
        }),
      ],
      isolationReasons: { "agent-1": UNISOLATED_REASON },
    });
    closeSession.mockResolvedValue(undefined);

    await useSessionStore.getState().closeSession("agent-1");

    expect(useSessionStore.getState().isolationReasons).toEqual({});
  });

  it("drops the flag when a live unisolated agent stops", () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          status: "running",
          worktreePath: null,
        }),
      ],
      isolationReasons: { "agent-1": UNISOLATED_REASON },
    });

    useSessionStore.getState().markExited("agent-1", null);

    const stopped = useSessionStore.getState().sessions[0];
    expect(stopped?.status).toBe("stopped");
    expect(isUnisolatedAgent(stopped!)).toBe(false);
    expect(useSessionStore.getState().isolationReasons).toEqual({});
  });

  it("does not flag a session after its worktree is discarded", async () => {
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

    const leftover = useSessionStore.getState().sessions[0];
    expect(leftover?.worktreePath).toBeNull();
    expect(isUnisolatedAgent(leftover!)).toBe(false);
    expect(useSessionStore.getState().isolationReasons).toEqual({});
  });

  it("does not flag a session after its worktree is merged", async () => {
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
    mergeSessionWorktree.mockResolvedValue({
      session: session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        status: "stopped",
        worktreePath: null,
      }),
    });

    await useSessionStore.getState().mergeWorktree("agent-1");

    const leftover = useSessionStore.getState().sessions[0];
    expect(leftover?.worktreePath).toBeNull();
    expect(isUnisolatedAgent(leftover!)).toBe(false);
    expect(useSessionStore.getState().isolationReasons).toEqual({});
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

  it("allocates a new array on every call even when contents match", () => {
    const sessions = [session({ id: "a", projectId: "p1" })];
    expect(sessionsForProject(sessions, "p1")).not.toBe(sessionsForProject(sessions, "p1"));
    expect(sessionsForProject([], "p1")).not.toBe(sessionsForProject([], "p1"));
  });
});

describe("appendUpdate", () => {
  it("folds consecutive message chunks into one line", () => {
    useSessionStore.getState().appendUpdate("s1", { kind: "message", text: "Hel" });
    useSessionStore.getState().appendUpdate("s1", { kind: "message", text: "lo" });
    useSessionStore.getState().appendUpdate("s1", { kind: "tool", text: "Read src/lib.rs" });

    expect(useUiStore.getState().transcript["s1"]).toEqual([
      { kind: "message", text: "Hello" },
      { kind: "tool", text: "Read src/lib.rs" },
    ]);
  });
});

describe("doom loop", () => {
  const same = { kind: "tool" as const, text: "Read · {\"path\":\"src/lib.rs\"}" };
  const other = { kind: "tool" as const, text: "Read · {\"path\":\"src/main.rs\"}" };

  it("trips after five identical tool texts and not after four", () => {
    for (let i = 0; i < 4; i += 1) {
      useSessionStore.getState().appendUpdate("s1", same);
    }
    expect(useSessionStore.getState().doomLoops["s1"]).toBeUndefined();

    useSessionStore.getState().appendUpdate("s1", same);
    expect(useSessionStore.getState().doomLoops["s1"]).toEqual({
      text: same.text,
      count: 5,
    });
  });

  it("does not trip when args differ", () => {
    for (let i = 0; i < 4; i += 1) {
      useSessionStore.getState().appendUpdate("s1", same);
    }
    useSessionStore.getState().appendUpdate("s1", other);
    expect(useSessionStore.getState().doomLoops["s1"]).toBeUndefined();
    expect(useSessionStore.getState().toolRepeats["s1"]).toEqual({
      text: other.text,
      count: 1,
    });
  });

  it("Continue dismisses the prompt and resets the streak", () => {
    for (let i = 0; i < 5; i += 1) {
      useSessionStore.getState().appendUpdate("s1", same);
    }

    useSessionStore.getState().continueDoomLoop("s1");

    expect(useSessionStore.getState().doomLoops["s1"]).toBeUndefined();
    expect(useSessionStore.getState().toolRepeats["s1"]).toBeUndefined();
  });

  it("Pause cancels the turn and clears the prompt", async () => {
    cancelSession.mockResolvedValue(undefined);
    for (let i = 0; i < 5; i += 1) {
      useSessionStore.getState().appendUpdate("s1", same);
    }

    await useSessionStore.getState().pauseDoomLoop("s1");

    expect(cancelSession).toHaveBeenCalledWith("s1");
    expect(useSessionStore.getState().doomLoops["s1"]).toBeUndefined();
  });

  it("does not stack a second prompt while one is already showing", () => {
    for (let i = 0; i < 5; i += 1) {
      useSessionStore.getState().appendUpdate("s1", same);
    }
    useSessionStore.getState().appendUpdate("s1", same);

    expect(useSessionStore.getState().doomLoops["s1"]?.count).toBe(5);
    expect(useSessionStore.getState().toolRepeats["s1"]?.count).toBe(6);
  });
});

describe("promptSession", () => {
  it("records the follow-up after the backend accepts it", async () => {
    promptSession.mockResolvedValue(undefined);

    await useSessionStore.getState().promptSession("s1", "  what leaked?  ");

    expect(promptSession).toHaveBeenCalledWith("s1", "what leaked?");
    expect(useUiStore.getState().transcript["s1"]).toEqual([
      { kind: "prompt", text: "what leaked?" },
    ]);
  });

  it("does not record a follow-up the backend refused", async () => {
    promptSession.mockRejectedValue("that session is no longer running");

    await useSessionStore.getState().promptSession("s1", "hello");

    expect(useUiStore.getState().transcript["s1"]).toBeUndefined();
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
