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

const { talkToSession } = await import("./talkToSession");

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

describe("talkToSession", () => {
  it("prompts an ACP agent rather than writing a pty it does not have", async () => {
    await talkToSession(session({ kind: "agent", paneId: null, status: "idle" }), "hello");

    expect(promptSession).toHaveBeenCalledWith("s1", "hello");
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("types into a Grok pane and submits with a trailing CR", async () => {
    await talkToSession(session(), "hello");

    expect(writeSession).toHaveBeenCalledWith("s1", "hello\r");
    expect(promptSession).not.toHaveBeenCalled();
  });

  it("types into a shell the same way, so a forgotten CR is not a third path", async () => {
    await talkToSession(session({ kind: "shell" }), "ls");

    expect(writeSession).toHaveBeenCalledWith("s1", "ls\r");
    expect(promptSession).not.toHaveBeenCalled();
  });
});
