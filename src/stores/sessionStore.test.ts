import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../types";

const listSessions = vi.fn();
const createSession = vi.fn();
const stopSession = vi.fn();
const restartSession = vi.fn();
const renameSession = vi.fn();
const closeSession = vi.fn();
const disposeTerminal = vi.fn();

// Mocked wholesale: the real module pulls in xterm and its stylesheet, neither
// of which belongs in a store test.
vi.mock("../lib/terminals", () => ({ disposeTerminal }));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: { listSessions, createSession, stopSession, restartSession, renameSession, closeSession },
  };
});

const { sessionForPane, useSessionStore } = await import("./sessionStore");
const { useGraphStore } = await import("./graphStore");

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

const initialState = useSessionStore.getState();
const initialGraphState = useGraphStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState(initialState, true);
  useGraphStore.setState(initialGraphState, true);
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

describe("restartSession", () => {
  it("swaps in the new session and disposes the old terminal", async () => {
    useSessionStore.setState({ sessions: [session({ id: "old", paneId: "1" })] });
    restartSession.mockResolvedValue(session({ id: "fresh", paneId: "1" }));

    await useSessionStore.getState().restartSession("old", 100, 30);

    expect(restartSession).toHaveBeenCalledWith("old", 100, 30);
    // Restarting mints a new id, so the old xterm instance has to go.
    expect(disposeTerminal).toHaveBeenCalledWith("old");
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["fresh"]);
  });

  it("does not carry the previous run's graph over to the new session", async () => {
    useSessionStore.setState({ sessions: [session({ id: "old", paneId: "1" })] });
    useGraphStore.setState({ bySession: { old: graphEntry() } });
    restartSession.mockResolvedValue(session({ id: "fresh", paneId: "1" }));

    await useSessionStore.getState().restartSession("old", 100, 30);

    expect(useGraphStore.getState().bySession).toEqual({});
  });
});

describe("closeSession", () => {
  it("frees the pane and disposes the terminal", async () => {
    useSessionStore.setState({ sessions: [session(), session({ id: "s2", paneId: "1" })] });
    closeSession.mockResolvedValue(undefined);

    await useSessionStore.getState().closeSession("s1");

    expect(disposeTerminal).toHaveBeenCalledWith("s1");
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["s2"]);
  });

  it("drops the closed session's graph and leaves the other pane's alone", async () => {
    useSessionStore.setState({ sessions: [session(), session({ id: "s2", paneId: "1" })] });
    useGraphStore.setState({ bySession: { s1: graphEntry(), s2: graphEntry() } });
    closeSession.mockResolvedValue(undefined);

    await useSessionStore.getState().closeSession("s1");

    expect(Object.keys(useGraphStore.getState().bySession)).toEqual(["s2"]);
  });

  it("keeps the session when the backend refuses", async () => {
    useSessionStore.setState({ sessions: [session()] });
    closeSession.mockRejectedValue("busy");

    await useSessionStore.getState().closeSession("s1");

    expect(useSessionStore.getState().sessions).toHaveLength(1);
    expect(disposeTerminal).not.toHaveBeenCalled();
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
  it("switches one pane to its graph without touching the others", () => {
    const { setPaneView } = useSessionStore.getState();

    setPaneView("1", "graph");

    const { paneViews } = useSessionStore.getState();
    expect(paneViews["1"]).toBe("graph");
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
