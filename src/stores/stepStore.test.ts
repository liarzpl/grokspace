import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSteps, SkillStatus } from "../types";

const listSessionSteps = vi.fn();
const addSessionStep = vi.fn();
const updateSessionStep = vi.fn();
const removeSessionStep = vi.fn();
const reorderSessionSteps = vi.fn();
const approveSessionSteps = vi.fn();
const reopenSessionSteps = vi.fn();
const stepsSkillStatus = vi.fn();
const installStepsSkill = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      listSessionSteps,
      addSessionStep,
      updateSessionStep,
      removeSessionStep,
      reorderSessionSteps,
      approveSessionSteps,
      reopenSessionSteps,
      stepsSkillStatus,
      installStepsSkill,
    },
  };
});

const { stepsFor, useStepStore } = await import("./stepStore");

function snapshot(overrides: Partial<SessionSteps> = {}): SessionSteps {
  return {
    sessionId: "s1",
    phase: "proposed",
    steps: [
      {
        id: "a",
        sessionId: "s1",
        sortIndex: 0,
        title: "Read auth.ts",
        status: "pending",
        origin: "agent",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    ...overrides,
  };
}

const initialState = useStepStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  useStepStore.setState(initialState, true);
});

const entry = (sessionId: string) => stepsFor(useStepStore.getState().bySession, sessionId);

describe("load", () => {
  it("takes the list the backend returns", async () => {
    listSessionSteps.mockResolvedValue(snapshot());

    await useStepStore.getState().load("s1");

    expect(listSessionSteps).toHaveBeenCalledWith("s1");
    expect(entry("s1").phase).toBe("proposed");
    expect(entry("s1").steps[0]?.title).toBe("Read auth.ts");
    expect(entry("s1").isLoading).toBe(false);
  });

  it("keeps each session's list to itself", async () => {
    listSessionSteps.mockImplementation((id: string) =>
      Promise.resolve(
        id === "s1"
          ? snapshot()
          : snapshot({
              sessionId: "s2",
              steps: [
                {
                  id: "b",
                  sessionId: "s2",
                  sortIndex: 0,
                  title: "Other run",
                  status: "doing",
                  origin: "agent",
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
            }),
      ),
    );

    await useStepStore.getState().load("s1");
    await useStepStore.getState().load("s2");

    expect(entry("s1").steps[0]?.title).toBe("Read auth.ts");
    expect(entry("s2").steps[0]?.title).toBe("Other run");
  });

  it("surfaces a failed read on the store rather than throwing", async () => {
    listSessionSteps.mockRejectedValue("database is locked");

    await useStepStore.getState().load("s1");

    expect(useStepStore.getState().error).toBe("database is locked");
    expect(entry("s1").isLoading).toBe(false);
  });
});

describe("syncSessions", () => {
  it("drops lists that do not belong to the arriving sessions", async () => {
    listSessionSteps.mockResolvedValue(snapshot({ sessionId: "s2", steps: [] }));
    useStepStore.setState({
      bySession: {
        s1: { sessionId: "s1", phase: "proposed", steps: snapshot().steps, isLoading: false },
      },
    });

    await useStepStore.getState().syncSessions(["s2"]);

    expect(Object.keys(useStepStore.getState().bySession)).toEqual(["s2"]);
  });

  it("lets the later sync win when two complete out of order", async () => {
    let resolveFirst: (value: SessionSteps) => void = () => {};
    listSessionSteps.mockImplementation((id: string) => {
      if (id === "s1") {
        return new Promise<SessionSteps>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(snapshot({ sessionId: "s2", steps: [] }));
    });

    const first = useStepStore.getState().syncSessions(["s1"]);
    const second = useStepStore.getState().syncSessions(["s2"]);
    await second;
    resolveFirst(snapshot());
    await first;

    expect(Object.keys(useStepStore.getState().bySession)).toEqual(["s2"]);
  });
});

describe("refresh", () => {
  it("re-reads an open session after a short wait", async () => {
    listSessionSteps.mockResolvedValue(snapshot());
    vi.useFakeTimers();

    useStepStore.getState().refresh("s1", true);
    await vi.advanceTimersByTimeAsync(200);

    expect(listSessionSteps).toHaveBeenCalledWith("s1");
    expect(entry("s1").steps[0]?.title).toBe("Read auth.ts");
  });

  it("forgets a session that is no longer open rather than re-reading it", async () => {
    useStepStore.setState({
      bySession: {
        s1: { sessionId: "s1", phase: "proposed", steps: snapshot().steps, isLoading: false },
      },
    });

    useStepStore.getState().refresh("s1", false);

    expect(listSessionSteps).not.toHaveBeenCalled();
    expect(useStepStore.getState().bySession).toEqual({});
  });
});

describe("forget", () => {
  it("drops a closed session and leaves the others alone", async () => {
    listSessionSteps.mockResolvedValue(snapshot());
    await useStepStore.getState().load("s1");
    listSessionSteps.mockResolvedValue(snapshot({ sessionId: "s2", steps: [] }));
    await useStepStore.getState().load("s2");

    useStepStore.getState().forget("s1");

    expect(Object.keys(useStepStore.getState().bySession)).toEqual(["s2"]);
    expect(entry("s1").steps).toEqual([]);
  });

  it("ignores a late read that finishes after the session is gone", async () => {
    let release: (value: SessionSteps) => void = () => {};
    listSessionSteps.mockReturnValue(
      new Promise<SessionSteps>((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = useStepStore.getState().load("s1");
    useStepStore.getState().forget("s1");
    release(snapshot());
    await inFlight;

    expect(useStepStore.getState().bySession).toEqual({});
  });
});

describe("reset", () => {
  it("empties the list in place so a new dispatch does not keep the last tally", () => {
    useStepStore.setState({
      bySession: {
        s1: { sessionId: "s1", phase: "approved", steps: snapshot().steps, isLoading: false },
      },
    });

    useStepStore.getState().reset("s1");

    expect(entry("s1").phase).toBe("none");
    expect(entry("s1").steps).toEqual([]);
    expect(entry("s1").isLoading).toBe(false);
  });

  it("drops an in-flight read so dispatch cannot bring the last job back", async () => {
    let release: (value: SessionSteps) => void = () => {};
    listSessionSteps.mockReturnValue(
      new Promise<SessionSteps>((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = useStepStore.getState().load("s1");
    useStepStore.getState().reset("s1");
    release(snapshot({ phase: "approved" }));
    await inFlight;

    expect(entry("s1").phase).toBe("none");
    expect(entry("s1").steps).toEqual([]);
  });
});

describe("mutations", () => {
  it("replaces the session with the snapshot the backend returns", async () => {
    useStepStore.setState({
      bySession: {
        s1: { sessionId: "s1", phase: "proposed", steps: snapshot().steps, isLoading: false },
      },
    });
    addSessionStep.mockResolvedValue(
      snapshot({
        steps: [
          ...snapshot().steps,
          {
            id: "u",
            sessionId: "s1",
            sortIndex: 1,
            title: "Also the tests",
            status: "pending",
            origin: "user",
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      }),
    );

    const ok = await useStepStore.getState().add("s1", "Also the tests");

    expect(ok).toBe(true);
    expect(entry("s1").steps.map((step) => step.title)).toEqual([
      "Read auth.ts",
      "Also the tests",
    ]);
  });

  it("does not resurrect a session that was forgotten while a write was in flight", async () => {
    useStepStore.setState({
      bySession: {
        s1: { sessionId: "s1", phase: "proposed", steps: snapshot().steps, isLoading: false },
      },
    });
    addSessionStep.mockResolvedValue(snapshot());

    useStepStore.getState().forget("s1");
    await useStepStore.getState().add("s1", "Also the tests");

    expect(useStepStore.getState().bySession).toEqual({});
  });

  it("approve locks the list and returns it for the caller to prompt with", async () => {
    useStepStore.setState({
      bySession: {
        s1: { sessionId: "s1", phase: "proposed", steps: snapshot().steps, isLoading: false },
      },
    });
    approveSessionSteps.mockResolvedValue(snapshot({ phase: "approved" }));

    const frozen = await useStepStore.getState().approve("s1");

    expect(approveSessionSteps).toHaveBeenCalledWith("s1");
    expect(frozen?.phase).toBe("approved");
    expect(frozen?.steps[0]?.title).toBe("Read auth.ts");
    expect(entry("s1").phase).toBe("approved");
  });

  it("leaves the list alone when approve is refused", async () => {
    useStepStore.setState({
      bySession: {
        s1: { sessionId: "s1", phase: "proposed", steps: snapshot().steps, isLoading: false },
      },
    });
    approveSessionSteps.mockRejectedValue("nothing to approve");

    const frozen = await useStepStore.getState().approve("s1");

    expect(frozen).toBeNull();
    expect(entry("s1").phase).toBe("proposed");
    expect(useStepStore.getState().error).toBe("nothing to approve");
  });

  it("reopen puts an approved list back so Approve can be tried again", async () => {
    useStepStore.setState({
      bySession: {
        s1: { sessionId: "s1", phase: "approved", steps: snapshot().steps, isLoading: false },
      },
    });
    reopenSessionSteps.mockResolvedValue(snapshot({ phase: "proposed" }));

    await useStepStore.getState().reopen("s1");

    expect(reopenSessionSteps).toHaveBeenCalledWith("s1");
    expect(entry("s1").phase).toBe("proposed");
  });
});

const skill = (overrides: Partial<SkillStatus> = {}): SkillStatus => ({
  path: "/home/dev/.grok/skills/grokspace-steps/SKILL.md",
  installed: true,
  current: true,
  ...overrides,
});

describe("loadSkill", () => {
  it("asks the backend once however many panes want to know", async () => {
    stepsSkillStatus.mockResolvedValue(skill({ installed: false, current: false }));

    await useStepStore.getState().loadSkill();
    await useStepStore.getState().loadSkill();

    expect(stepsSkillStatus).toHaveBeenCalledTimes(1);
  });
});
