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

const initialState = useSessionStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState(initialState, true);
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
});

describe("closeSession", () => {
  it("frees the pane and disposes the terminal", async () => {
    useSessionStore.setState({ sessions: [session(), session({ id: "s2", paneId: "1" })] });
    closeSession.mockResolvedValue(undefined);

    await useSessionStore.getState().closeSession("s1");

    expect(disposeTerminal).toHaveBeenCalledWith("s1");
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["s2"]);
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

describe("sessionForPane", () => {
  it("finds the session occupying a pane", () => {
    const sessions = [session({ id: "a", paneId: "0" }), session({ id: "b", paneId: "3" })];

    expect(sessionForPane(sessions, "3")?.id).toBe("b");
    expect(sessionForPane(sessions, "1")).toBeUndefined();
  });
});
