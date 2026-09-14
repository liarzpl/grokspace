import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project, Session } from "../types";

// Mocked wholesale for the reason the session store's tests give: the real module
// pulls in xterm, and a command list has no business dragging a terminal emulator
// into its tests.
vi.mock("../lib/terminals", () => ({ disposeTerminal: vi.fn(), detachTerminal: vi.fn() }));

const createSession = vi.fn();
const updateProject = vi.fn();
const removeProject = vi.fn();
const listSessions = vi.fn();
const stopSession = vi.fn();
const closeSession = vi.fn();
const restartSession = vi.fn();
const discardSessionWorktree = vi.fn();
const mergeSessionWorktree = vi.fn();
const sessionMergeReadiness = vi.fn();
const approveSessionSteps = vi.fn();
const reopenSessionSteps = vi.fn();
const writeSession = vi.fn();
const promptSession = vi.fn();
const cancelSession = vi.fn();
const installSkill = vi.fn();
const skillStatus = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      createSession,
      updateProject,
      removeProject,
      listProjects: vi.fn(),
      listSessions,
      stopSession,
      closeSession,
      restartSession,
      discardSessionWorktree,
      mergeSessionWorktree,
      sessionMergeReadiness,
      approveSessionSteps,
      reopenSessionSteps,
      writeSession,
      promptSession,
      cancelSession,
      installSkill,
      skillStatus,
    },
  };
});

const { commands, matching } = await import("./commands");
const { useProjectStore } = await import("../stores/projectStore");
const { useSessionStore } = await import("../stores/sessionStore");
const { useSkillStore } = await import("../stores/skillStore");
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
const initialSkills = useSkillStore.getState();

const ISOLATION_ERR =
  "isolation did not happen (this folder is not a git repository); confirm to start on the project tree";

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.getState().cancelUnisolatedStart();
  useUiStore.setState(initialUi, true);
  useProjectStore.setState(initialProjects, true);
  useSessionStore.setState(initialSessions, true);
  useStepStore.setState(initialSteps, true);
  useSkillStore.setState(initialSkills, true);
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

  it("offers Forget for every remembered project, including the open one", () => {
    // Hover-only sidebar chrome left keyboard users unable to remove a project.
    useProjectStore.setState({ projects: [project(), project({ id: "p2", name: "other" })] });

    const shown = labels(project());

    expect(shown).toContain("Forget acme-api");
    expect(shown).toContain("Forget other");
    expect(labels(null)).toContain("Forget other");
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

  it("offers Hand to Coder and Reviewer from a live Planner, not a stopped one", () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "planner-1",
          paneId: null,
          kind: "agent",
          title: "Planner",
          role: "Planner",
          status: "idle",
        }),
        session({
          id: "dead-1",
          paneId: null,
          kind: "agent",
          title: "Old Planner",
          role: "Planner",
          status: "stopped",
        }),
      ],
    });
    expect(labels(project())).toEqual(
      expect.arrayContaining(["Hand to Coder", "Hand to Reviewer"]),
    );
    expect(labels(project()).filter((label) => label === "Hand to Coder")).toHaveLength(1);
  });

  it("offers Restart for a stopped agent, and Discard when it still has a worktree", () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          title: "Reviewer",
          status: "stopped",
          worktreePath: "/tmp/acme/.grokspace/worktrees/agent-1",
        }),
      ],
    });

    const shown = labels(project());

    expect(shown).toContain("Restart Reviewer");
    expect(shown).toContain("Merge Reviewer");
    expect(shown).toContain("Discard worktree for Reviewer");
    expect(shown).toContain("Close Reviewer");
    expect(shown).not.toContain("Stop Reviewer");
    expect(shown).not.toContain("Cancel Reviewer");
  });

  it("does not offer Merge unless the agent is stopped and still has a worktree", () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "live",
          paneId: null,
          kind: "agent",
          title: "Coder",
          status: "running",
          worktreePath: "/tmp/acme/.grokspace/worktrees/live",
        }),
        session({
          id: "done",
          paneId: null,
          kind: "agent",
          title: "Scout",
          status: "stopped",
          worktreePath: null,
        }),
      ],
    });

    const shown = labels(project());

    expect(shown).not.toContain("Merge Coder");
    expect(shown).not.toContain("Merge Scout");
    expect(shown).toContain("Stop Coder");
    expect(shown).toContain("Restart Scout");
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

  it("offers one click for all three skills once there is a project", () => {
    const with_ = labels(project());

    expect(with_).toContain("Refresh the skill list");
    expect(with_).toContain("Install or refresh GrokSpace skills");
    expect(with_).toContain("Install or refresh the graph skill");
    expect(with_).toContain("Install or refresh the memory skill");
    expect(with_).toContain("Install or refresh the steps skill");
    expect(labels(null)).not.toContain("Install or refresh GrokSpace skills");
  });

  it("lists each bundled skill as installed or missing", () => {
    const slot = (installed: boolean) => ({
      status: {
        path: "/home/dev/.grok/skills/x",
        installed,
        current: installed,
      },
      isInstalling: false,
      error: null,
    });
    useSkillStore.setState({
      byId: {
        graph: slot(true),
        memory: slot(false),
        steps: slot(true),
      },
    });

    const shown = labels(project());

    expect(shown).toContain("Refresh the graph skill (installed)");
    expect(shown).toContain("Install the memory skill (missing)");
    expect(shown).toContain("Refresh the steps skill (installed)");
    expect(shown).not.toContain("Install or refresh the graph skill");
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

  it("surfaces swarm failures from the palette instead of swallowing them", async () => {
    createSession.mockRejectedValue("could not find `grok` on PATH");

    commands(project()).find((command) => command.id === "launch-swarm")?.run();
    await vi.waitFor(() =>
      expect(useSessionStore.getState().error).toContain("Planner"),
    );

    expect(useSessionStore.getState().error).toContain("could not find `grok` on PATH");
    expect(useSessionStore.getState().error).toContain("Reviewer");
  });

  it("asks before starting an agent or swarm on the project tree, not via the banner", async () => {
    createSession.mockRejectedValue(ISOLATION_ERR);

    commands(project()).find((command) => command.id === "start-agent")?.run();
    await vi.waitFor(() => expect(useSessionStore.getState().isolationConfirm).not.toBeNull());
    expect(useSessionStore.getState().error).toBeNull();
    useSessionStore.getState().cancelUnisolatedStart();

    commands(project()).find((command) => command.id === "launch-swarm")?.run();
    await vi.waitFor(() => expect(useSessionStore.getState().isolationConfirm).not.toBeNull());
    expect(useSessionStore.getState().error).toBeNull();
    expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("allowUnisolated");
  });

  it("hands a live Planner to Coder from the palette", async () => {
    useUiStore.setState({ isPaletteOpen: true });
    useSessionStore.setState({
      sessions: [
        session({
          id: "planner-1",
          paneId: null,
          kind: "agent",
          title: "Planner",
          role: "Planner",
          status: "idle",
        }),
      ],
    });
    createSession.mockReset();
    promptSession.mockReset();
    createSession.mockResolvedValue(
      session({ id: "coder-1", paneId: null, kind: "agent", role: "Coder", status: "idle" }),
    );
    promptSession.mockResolvedValue(undefined);

    commands(project()).find((command) => command.id === "hand-planner-1-to-Coder")?.run();
    await vi.waitFor(() =>
      expect(promptSession).toHaveBeenCalledWith("coder-1", expect.stringContaining("read-only")),
    );

    expect(useUiStore.getState().isPaletteOpen).toBe(false);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ role: "Coder", kind: "agent" }));
  });

  it("forgets a project and closes the palette", async () => {
    useProjectStore.setState({
      projects: [project(), project({ id: "p2", name: "other" })],
      activeProjectId: "p1",
    });
    useUiStore.setState({ isPaletteOpen: true });
    listSessions.mockResolvedValue([]);
    removeProject.mockResolvedValue(undefined);

    commands(project()).find((command) => command.id === "forget-p2")?.run();
    await vi.waitFor(() => expect(removeProject).toHaveBeenCalledWith("p2"));

    expect(useUiStore.getState().isPaletteOpen).toBe(false);
    expect(useProjectStore.getState().projects.map((entry) => entry.id)).toEqual(["p1"]);
  });

  it("installs graph, memory, and steps together, and names a failure without stopping", async () => {
    const ok = { path: "/h/.grok/skills/x", installed: true, current: true };
    installSkill.mockImplementation(async (id: string) => {
      if (id === "graph") throw "permission denied";
      return ok;
    });

    commands(project()).find((command) => command.id === "install-grokspace-skills")?.run();
    await vi.waitFor(() => expect(installSkill).toHaveBeenCalledWith("steps"));

    expect(installSkill).toHaveBeenCalledWith("graph");
    expect(installSkill).toHaveBeenCalledWith("memory");
    expect(useSkillStore.getState().byId.graph.error).toBe(
      "Could not install the graph skill: permission denied",
    );
    expect(useSkillStore.getState().byId.memory.status?.current).toBe(true);
    expect(useSkillStore.getState().byId.steps.status?.current).toBe(true);
  });

  it("does not invoke merge when readiness already names a refusal", async () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          title: "Reviewer",
          status: "stopped",
          worktreePath: "/tmp/acme/.grokspace/worktrees/agent-1",
        }),
      ],
    });
    sessionMergeReadiness.mockResolvedValue("commit or stash the project first");

    commands(project()).find((command) => command.id === "merge-agent-agent-1")?.run();
    await vi.waitFor(() =>
      expect(useSessionStore.getState().mergeReasons["agent-1"]).toBe(
        "commit or stash the project first",
      ),
    );

    expect(sessionMergeReadiness).toHaveBeenCalledWith("agent-1");
    expect(mergeSessionWorktree).not.toHaveBeenCalled();
    expect(useSessionStore.getState().error).toBeNull();
  });

  it("merges a stopped worktree when readiness is null", async () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "agent-1",
          paneId: null,
          kind: "agent",
          title: "Reviewer",
          status: "stopped",
          worktreePath: "/tmp/acme/.grokspace/worktrees/agent-1",
        }),
      ],
    });
    sessionMergeReadiness.mockResolvedValue(null);
    mergeSessionWorktree.mockResolvedValue({
      session: session({
        id: "agent-1",
        paneId: null,
        kind: "agent",
        title: "Reviewer",
        status: "stopped",
        worktreePath: null,
      }),
    });

    commands(project()).find((command) => command.id === "merge-agent-agent-1")?.run();
    await vi.waitFor(() => expect(mergeSessionWorktree).toHaveBeenCalledWith("agent-1"));

    expect(useSessionStore.getState().sessions[0]?.worktreePath).toBeNull();
  });

  it("refreshes the skill list without installing", async () => {
    const ok = { path: "/h/.grok/skills/x", installed: true, current: true };
    skillStatus.mockResolvedValue(ok);
    useUiStore.setState({ isPaletteOpen: true });

    commands(project()).find((command) => command.id === "refresh-skill-list")?.run();
    await vi.waitFor(() => expect(skillStatus).toHaveBeenCalledWith("steps"));

    expect(skillStatus.mock.calls.map((call) => call[0])).toEqual([
      "graph",
      "memory",
      "steps",
    ]);
    expect(installSkill).not.toHaveBeenCalled();
    expect(useUiStore.getState().isPaletteOpen).toBe(true);
    expect(labels(project())).toContain("Refresh the graph skill (installed)");
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
