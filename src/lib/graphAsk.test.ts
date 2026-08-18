import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../types";

const writeSession = vi.fn();
const promptSession = vi.fn();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    errorMessage: actual.errorMessage,
    api: { writeSession, promptSession },
  };
});

const { askForGraph, canAskForGraph, GRAPH_REQUEST } = await import("./graphAsk");

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    paneId: "0",
    processId: 1,
    status: "running",
    title: "Grok",
    role: null,
    worktreePath: null,
    kind: "grok",
    exitCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  writeSession.mockResolvedValue(undefined);
  promptSession.mockResolvedValue(undefined);
});

describe("canAskForGraph", () => {
  it("asks a running Grok terminal", () => {
    expect(canAskForGraph(session())).toBe(true);
    expect(canAskForGraph(session({ status: "stopped" }))).toBe(false);
  });

  it("asks an idle ACP agent, not a running or blocked one", () => {
    const agent = session({ kind: "agent", paneId: null, status: "idle" });
    expect(canAskForGraph(agent)).toBe(true);
    expect(canAskForGraph({ ...agent, status: "running" })).toBe(false);
    expect(canAskForGraph({ ...agent, status: "needs_input" })).toBe(false);
    expect(canAskForGraph({ ...agent, status: "stopped" })).toBe(false);
  });

  it("never asks a shell", () => {
    expect(canAskForGraph(session({ kind: "shell" }))).toBe(false);
  });
});

describe("askForGraph", () => {
  it("types into a Grok pane", async () => {
    await askForGraph(session());
    expect(writeSession).toHaveBeenCalledWith("s1", `${GRAPH_REQUEST}\r`);
    expect(promptSession).not.toHaveBeenCalled();
  });

  it("prompts an ACP agent rather than writing a pty it does not have", async () => {
    await askForGraph(session({ kind: "agent", paneId: null, status: "idle" }));
    expect(promptSession).toHaveBeenCalledWith("s1", GRAPH_REQUEST);
    expect(writeSession).not.toHaveBeenCalled();
  });
});
