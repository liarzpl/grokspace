import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session, SessionStep } from "../types";

const writeSession = vi.fn();
const promptSession = vi.fn();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    errorMessage: actual.errorMessage,
    api: { writeSession, promptSession },
  };
});

const {
  approvalPrompt,
  canApproveSteps,
  sendApproval,
  sessionsWithSteps,
  stepProgress,
} = await import("./steps");

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

function step(overrides: Partial<SessionStep> = {}): SessionStep {
  return {
    id: "a",
    sessionId: "s1",
    sortIndex: 0,
    title: "Read auth.ts",
    status: "pending",
    origin: "agent",
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

describe("canApproveSteps", () => {
  it("approves a proposed list on a running Grok terminal", () => {
    expect(canApproveSteps(session(), "proposed", 2)).toBe(true);
    expect(canApproveSteps(session({ status: "stopped" }), "proposed", 2)).toBe(false);
  });

  it("approves an idle ACP agent, not a running or blocked one", () => {
    const agent = session({ kind: "agent", paneId: null, status: "idle" });
    expect(canApproveSteps(agent, "proposed", 2)).toBe(true);
    expect(canApproveSteps({ ...agent, status: "running" }, "proposed", 2)).toBe(false);
    expect(canApproveSteps({ ...agent, status: "needs_input" }, "proposed", 2)).toBe(false);
  });

  it("does nothing when there is no proposed list", () => {
    expect(canApproveSteps(session(), "none", 0)).toBe(false);
    expect(canApproveSteps(session(), "approved", 2)).toBe(false);
    expect(canApproveSteps(session(), "proposed", 0)).toBe(false);
  });

  it("never approves a shell", () => {
    expect(canApproveSteps(session({ kind: "shell" }), "proposed", 2)).toBe(false);
  });
});

describe("approvalPrompt", () => {
  it("is one line listing the frozen titles in order", () => {
    const prompt = approvalPrompt([
      step({ title: "Read auth.ts" }),
      step({ id: "b", title: "The session cookie\nis dropped" }),
    ]);

    expect(prompt).not.toContain("\n");
    expect(prompt).toBe(
      "Approved. Continue as written: 1. Read auth.ts 2. The session cookie is dropped",
    );
  });
});

describe("sendApproval", () => {
  it("types into a Grok pane", async () => {
    const steps = [step()];
    await sendApproval(session(), steps);
    expect(writeSession).toHaveBeenCalledWith("s1", `${approvalPrompt(steps)}\r`);
    expect(promptSession).not.toHaveBeenCalled();
  });

  it("prompts an ACP agent rather than writing a pty it does not have", async () => {
    const steps = [step()];
    await sendApproval(session({ kind: "agent", paneId: null, status: "idle" }), steps);
    expect(promptSession).toHaveBeenCalledWith("s1", approvalPrompt(steps));
    expect(writeSession).not.toHaveBeenCalled();
  });
});

describe("stepProgress", () => {
  it("counts done against the length of the list", () => {
    expect(
      stepProgress([
        step({ status: "done" }),
        step({ id: "b", status: "doing" }),
        step({ id: "c", status: "skipped" }),
      ]),
    ).toEqual({ done: 1, total: 3 });
  });

  it("is silent when the list is empty", () => {
    expect(stepProgress([])).toBeNull();
  });
});

describe("sessionsWithSteps", () => {
  it("keeps Grok and agents, and drops shells", () => {
    const kept = sessionsWithSteps([
      session({ id: "g", kind: "grok" }),
      session({ id: "sh", kind: "shell", paneId: "1" }),
      session({ id: "a", kind: "agent", paneId: null }),
    ]);
    expect(kept.map((item) => item.id)).toEqual(["g", "a"]);
  });
});
