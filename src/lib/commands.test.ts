import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project, Session } from "../types";

// Mocked wholesale for the reason the session store's tests give: the real module
// pulls in xterm, and a command list has no business dragging a terminal emulator
// into its tests.
vi.mock("../lib/terminals", () => ({ disposeTerminal: vi.fn(), detachTerminal: vi.fn() }));

const createSession = vi.fn();
const updateProject = vi.fn();
const stopSession = vi.fn();
const closeSession = vi.fn();
const approveSessionSteps = vi.fn();
const reopenSessionSteps = vi.fn();
const writeSession = vi.fn();
const promptSession = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      createSession,
      updateProject,
      listProjects: vi.fn(),
      listSessions: vi.fn(),
      stopSession,
      closeSession,
      approveSessionSteps,
      reopenSessionSteps,
      writeSession,
      promptSession,
    },
  };
});

const { commands, matching } = await import("./commands");
const { useProjectStore } = await import("../stores/projectStore");
const { useSessionStore } = await import("../stores/sessionStore");
const { useStepStore } = await import("../stores/stepStore");
const { useUiStore } = await import("../stores/uiStore");

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "acme-api",
    path: "/Users/dev/acme-api",
    lastOpened: 1000,
    settings: { terminalLayout: "2x2" },
    createdAt: 1000,
    ...overrides,
  };
}

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
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const initialUi = useUiStore.getState();
const initialProjects = useProjectStore.getState();
const initialSessions = useSessionStore.getState();
const initialSteps = useStepStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState(initialUi, true);
  useProjectStore.setState(initialProjects, true);
  useSessionStore.setState(initialSessions, true);
  useStepStore.setState(initialSteps, true);
});

const labels = (project: Project | null) => commands(project).map((command) => command.label);

describe("the command list", () => {
  it("offers only what works without a project when there is none", () => {
    // Starting a session or setting a layout needs somewhere to do it, and a command
    // that cannot work is worse than one that is absent.
    const without = labels(null);

    expect(without).toContain("Open a project folder…");
    expect(without.some((label) => label.startsWith("Start"))).toBe(false);
    expect(without.some((label) => label.includes("layout"))).toBe(false);
  });

  it("offers the sessions and layouts once there is one", () => {
    const with_ = labels(project());

    expect(with_).toContain("Start Grok in the first free pane");
    expect(with_).toContain("Start an agent, which needs no pane");
    expect(with_).toContain("Use the 3x2 layout");
  });

  it("does not offer to switch to the project already open", () => {
    useProjectStore.setState({ projects: [project(), project({ id: "p2", name: "other" })] });

    const shown = labels(project());

    expect(shown).toContain("Switch to other");
    expect(shown).not.toContain("Switch to acme-api");
  });

  it("offers Cancel and Stop for a live agent, and not a second Stop for a terminal", () => {
    useSessionStore.setState({
      sessions: [
        session({ id: "agent-1", paneId: null, kind: "agent", title: "Reviewer", status: "running" }),
        session({ id: "grok-1", kind: "grok", title: "Grok", status: "running" }),
      ],
    });

    const shown = labels(project());

    expect(shown).toContain("Cancel Reviewer");
    expect(shown).toContain("Stop Reviewer");
    expect(shown).toContain("Close Reviewer");
    expect(shown).not.toContain("Stop Grok");
    expect(shown).not.toContain("Close Grok");
  });

  it("does not offer another project's agent while this one is open", () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-2",
          projectId: "p2",
          paneId: null,
          kind: "agent",
          title: "Other",
          status: "running",
        }),
      ],
    });

    const shown = labels(project());

    expect(shown).not.toContain("Stop Other");
    expect(shown).not.toContain("Cancel Other");
  });

  it("offers Approve when a session has a proposed list", () => {
    useSessionStore.setState({
      sessions: [session({ id: "s1", title: "Reviewer", kind: "grok", status: "running" })],
    });
    useStepStore.setState({
      bySession: {
        s1: {
          sessionId: "s1",
          phase: "proposed",
          steps: [
            {
              id: "a",
              sessionId: "s1",
              sortIndex: 0,
              title: "Read it",
              status: "pending",
              origin: "agent",
              createdAt: 0,
              updatedAt: 0,
            },
          ],
          isLoading: false,
        },
      },
    });

    expect(labels(project())).toContain("Approve steps for Reviewer");
  });

  it("gives every command a distinct id", () => {
    // Two commands sharing one id means React draws one of them and drops the other.
    useProjectStore.setState({ projects: [project(), project({ id: "p2", name: "other" })] });
    const ids = commands(project()).map((command) => command.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the key of a command that also has one", () => {
    const open = commands(null).find((command) => command.id === "open-project");

    expect(open?.shortcut).toBe("open-project");
  });
});

describe("running a command", () => {
  it("switches the tab, and the tab store closes the palette on the way", () => {
    // Otherwise the palette would sit over the panel it had just revealed.
    useUiStore.setState({ isPaletteOpen: true });

    commands(null).find((command) => command.id === "tab-tasks")?.run();

    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().isPaletteOpen).toBe(false);
  });

  it("starts a session in the lowest-numbered free pane", async () => {
    // Pane 0 is taken, so Grok belongs in 1.
    useSessionStore.setState({
      sessions: [
        {
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
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    createSession.mockResolvedValue(null);

    commands(project()).find((command) => command.id === "start-grok")?.run();
    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: "1", kind: "grok" }),
    );
  });

  it("says so rather than doing nothing when the grid is full", () => {
    // A 1x1 layout with its one pane taken.
    useSessionStore.setState({
      sessions: [
        {
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
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    commands(project({ settings: { terminalLayout: "1x1" } }))
      .find((command) => command.id === "start-grok")
      ?.run();

    expect(createSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().error).toContain("taken");
  });

  it("approves a proposed list and types the frozen titles into the session", async () => {
    const steps = [
      {
        id: "a",
        sessionId: "s1",
        sortIndex: 0,
        title: "Read it",
        status: "pending" as const,
        origin: "agent" as const,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    useSessionStore.setState({
      sessions: [session({ id: "s1", title: "Grok", kind: "grok", status: "running" })],
    });
    useStepStore.setState({
      bySession: { s1: { sessionId: "s1", phase: "proposed", steps, isLoading: false } },
    });
    approveSessionSteps.mockResolvedValue({ sessionId: "s1", phase: "approved", steps });
    writeSession.mockResolvedValue(undefined);

    commands(project()).find((command) => command.id === "approve-steps-s1")?.run();
    await vi.waitFor(() =>
      expect(writeSession).toHaveBeenCalledWith(
        "s1",
        "Approved. Continue as written: 1. Read it\r",
      ),
    );

    expect(approveSessionSteps).toHaveBeenCalledWith("s1");
    expect(promptSession).not.toHaveBeenCalled();
  });

  it("does not approve if the session is no longer ready when the command runs", async () => {
    const steps = [
      {
        id: "a",
        sessionId: "s1",
        sortIndex: 0,
        title: "Read it",
        status: "pending" as const,
        origin: "agent" as const,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    useSessionStore.setState({
      sessions: [session({ id: "s1", title: "Reviewer", kind: "agent", status: "idle" })],
    });
    useStepStore.setState({
      bySession: { s1: { sessionId: "s1", phase: "proposed", steps, isLoading: false } },
    });

    const command = commands(project()).find((entry) => entry.id === "approve-steps-s1");
    useSessionStore.setState({
      sessions: [session({ id: "s1", title: "Reviewer", kind: "agent", status: "running" })],
    });
    command?.run();
    await vi.waitFor(() =>
      expect(useStepStore.getState().error).toBe("That session is not ready to approve."),
    );

    expect(approveSessionSteps).not.toHaveBeenCalled();
    expect(promptSession).not.toHaveBeenCalled();
  });
});

describe("matching", () => {
  const all = commands(project());

  it("returns everything for an empty query", () => {
    expect(matching(all, "   ")).toHaveLength(all.length);
  });

  it("matches on a subsequence rather than a substring", () => {
    // "sgr" is how someone types "Start Grok" without looking.
    const found = matching(all, "sgr").map((command) => command.label);

    expect(found).toContain("Start Grok in the first free pane");
  });

  it("keeps declaration order rather than guessing at relevance", () => {
    const found = matching(all, "s").map((command) => command.id);
    const declared = all.filter((command) => found.includes(command.id)).map((c) => c.id);

    expect(found).toEqual(declared);
  });

  it("finds nothing when nothing matches", () => {
    expect(matching(all, "zzzqqq")).toEqual([]);
  });

  it("ignores case", () => {
    expect(matching(all, "SHOW TASKS").length).toBeGreaterThan(0);
  });
});
