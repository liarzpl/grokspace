import { beforeEach, describe, expect, it, vi } from "vitest";

import { EVENTS, listenBackendEvents, type BackendEventHandlers, type ListenFn } from "./events";

function fakeBus() {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const listen: ListenFn = async (event, handler) => {
    handlers.set(event, handler as (event: { payload: unknown }) => void);
    return () => {
      handlers.delete(event);
    };
  };
  return {
    listen,
    emit: (event: string, payload: unknown) => {
      handlers.get(event)?.({ payload });
    },
    subscribed: () => [...handlers.keys()].sort(),
  };
}

function handlers(overrides: Partial<BackendEventHandlers> = {}): BackendEventHandlers {
  return {
    markExited: vi.fn(),
    markStatus: vi.fn(),
    askPermission: vi.fn(),
    noteIsolation: vi.fn(),
    appendUpdate: vi.fn(),
    sessions: () => [{ id: "s1", status: "idle" }],
    refreshGraph: vi.fn(),
    refreshSteps: vi.fn(),
    activeProjectId: () => "p1",
    loadTasks: vi.fn(),
    noteDock: vi.fn(),
    ...overrides,
  };
}

describe("listenBackendEvents", () => {
  let bus: ReturnType<typeof fakeBus>;
  let wired: BackendEventHandlers;

  beforeEach(async () => {
    bus = fakeBus();
    wired = handlers();
    await listenBackendEvents(bus.listen, wired);
  });

  it("subscribes to every named backend event", () => {
    expect(bus.subscribed()).toEqual([...Object.values(EVENTS)].sort());
  });

  it("forwards an exit and notes the dock as stopped", () => {
    bus.emit(EVENTS.sessionExited, { id: "s1", exitCode: 1 });

    expect(wired.markExited).toHaveBeenCalledWith("s1", 1);
    expect(wired.noteDock).toHaveBeenCalledWith("s1", "stopped");
  });

  it("drops a late status for a session that is already stopped", () => {
    wired.sessions = () => [{ id: "s1", status: "stopped" }];

    bus.emit(EVENTS.sessionStatus, { id: "s1", status: "idle" });

    expect(wired.markStatus).not.toHaveBeenCalled();
    expect(wired.noteDock).not.toHaveBeenCalled();
  });

  it("drops a status event whose session has left the list", () => {
    wired.sessions = () => [];

    bus.emit(EVENTS.sessionStatus, { id: "gone", status: "idle" });

    expect(wired.markStatus).not.toHaveBeenCalled();
  });

  it("forwards a live status and notes the dock", () => {
    bus.emit(EVENTS.sessionStatus, { id: "s1", status: "needs_input" });

    expect(wired.markStatus).toHaveBeenCalledWith("s1", "needs_input");
    expect(wired.noteDock).toHaveBeenCalledWith("s1", "needs_input");
  });

  it("refreshes a graph for an open session and not as a resurrection", () => {
    bus.emit(EVENTS.graphChanged, { sessionId: "s1" });
    bus.emit(EVENTS.graphChanged, { sessionId: "gone" });

    expect(wired.refreshGraph).toHaveBeenCalledWith("s1", true);
    expect(wired.refreshGraph).toHaveBeenCalledWith("gone", false);
  });

  it("ignores tasks-changed for a project that is not on screen", () => {
    bus.emit(EVENTS.tasksChanged, { projectId: "other" });
    bus.emit(EVENTS.tasksChanged, { projectId: "p1" });

    expect(wired.loadTasks).toHaveBeenCalledOnce();
    expect(wired.loadTasks).toHaveBeenCalledWith("p1");
  });

  it("ignores empty or prompt-kind transcript updates", () => {
    bus.emit(EVENTS.sessionUpdate, { id: "s1", kind: "message", text: "" });
    bus.emit(EVENTS.sessionUpdate, { id: "s1", kind: "prompt", text: "hi" });
    bus.emit(EVENTS.sessionUpdate, { id: "s1", kind: "message", text: "hello" });

    expect(wired.appendUpdate).toHaveBeenCalledOnce();
    expect(wired.appendUpdate).toHaveBeenCalledWith("s1", { kind: "message", text: "hello" });
  });
});
