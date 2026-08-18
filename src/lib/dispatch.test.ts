import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project, Session } from "../types";

// The real terminal registry pulls in xterm, which a list of dispatch targets has no
// business dragging into its tests.
vi.mock("../lib/terminals", () => ({ disposeTerminal: vi.fn(), detachTerminal: vi.fn() }));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { errorMessage: actual.errorMessage, api: {} };
});

const { dispatchTargets, paneOf, targetKey, targetLabel } = await import("./dispatch");
const { useSettingsStore } = await import("../stores/settingsStore");

function project(layout = "2x2"): Project {
  return {
    id: "p1",
    name: "acme",
    path: "/tmp/acme",
    lastOpened: 0,
    settings: { terminalLayout: layout },
    createdAt: 0,
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

const initialSettings = useSettingsStore.getState();

beforeEach(() => {
  useSettingsStore.setState(initialSettings, true);
});

const kinds = (targets: ReturnType<typeof dispatchTargets>) =>
  targets.map((target) => targetKey(target));

describe("dispatchTargets", () => {
  it("offers every free pane, and a new agent", () => {
    const targets = kinds(dispatchTargets(project("2x2"), []));

    expect(targets).toEqual(["pane-0", "pane-1", "pane-2", "pane-3", "new-agent"]);
  });

  it("offers a running session instead of the pane it occupies", () => {
    const targets = kinds(dispatchTargets(project("2x1"), [session({ id: "s7", paneId: "0" })]));

    expect(targets).toEqual(["s7", "pane-1", "new-agent"]);
  });

  it("offers neither the pane nor the session when that session is stopped", () => {
    // Restarting it is a decision about that terminal, not about this task.
    const targets = kinds(
      dispatchTargets(project("2x1"), [session({ id: "s7", paneId: "0", status: "stopped" })]),
    );

    expect(targets).toEqual(["pane-1", "new-agent"]);
  });

  it("never offers a shell, which would run the task rather than read it", () => {
    const targets = kinds(
      dispatchTargets(project("2x1"), [session({ id: "sh", paneId: "0", kind: "shell" })]),
    );

    expect(targets).not.toContain("sh");
  });

  it("finds a running agent, which holds no pane to be found by", () => {
    const agent = session({ id: "a1", kind: "agent", paneId: null, status: "idle" });

    expect(kinds(dispatchTargets(project("1x1"), [agent]))).toEqual([
      "pane-0",
      "a1",
      "new-agent",
    ]);
  });

  it("puts the new agent last by default", () => {
    const targets = kinds(dispatchTargets(project("2x2"), []));

    expect(targets.at(-1)).toBe("new-agent");
  });

  it("puts the new agent first when that is what dispatch reaches for", () => {
    // The whole point of the preference: for somebody who always dispatches to an
    // agent, the chip they want is otherwise behind four panes.
    useSettingsStore.setState({
      settings: { ...initialSettings.settings, defaultDispatch: "agent" },
    });

    const targets = kinds(dispatchTargets(project("2x2"), []));

    expect(targets[0]).toBe("new-agent");
    expect(targets).toHaveLength(5);
  });

  it("reorders rather than removing, so nothing is chosen for anyone", () => {
    // A setting that picked the target would quietly send work somewhere nobody looked.
    const sessions = [session({ id: "s7", paneId: "0" })];
    const withPane = kinds(dispatchTargets(project("2x1"), sessions));

    useSettingsStore.setState({
      settings: { ...initialSettings.settings, defaultDispatch: "agent" },
    });
    const withAgent = kinds(dispatchTargets(project("2x1"), sessions));

    expect([...withAgent].sort()).toEqual([...withPane].sort());
  });

  it("still offers a new agent when the grid is full, since it needs no pane", () => {
    const targets = kinds(
      dispatchTargets(project("1x1"), [session({ id: "s7", paneId: "0", status: "stopped" })]),
    );

    expect(targets).toEqual(["new-agent"]);
  });
});

describe("the labels a target carries", () => {
  it("counts panes from one, because nobody calls the first pane zero", () => {
    expect(targetLabel({ kind: "pane", paneId: "0" })).toBe("1 · Start Grok");
  });

  it("names a paneless agent without a pane number", () => {
    const agent = session({ id: "a1", kind: "agent", paneId: null, title: "Planner" });

    expect(targetLabel({ kind: "session", session: agent })).toBe("Planner");
  });

  it("gives every target a distinct key, or React draws one and drops the others", () => {
    const targets = dispatchTargets(project("2x2"), [session({ id: "s7", paneId: "0" })]);
    const keys = targets.map(targetKey);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("paneOf", () => {
  it("is the pane for a pane, and null for anything that needs no pane", () => {
    // A null pane is what asks the session store for an agent rather than a terminal.
    expect(paneOf({ kind: "pane", paneId: "2" })).toBe("2");
    expect(paneOf({ kind: "agent" })).toBeNull();
    expect(paneOf({ kind: "session", session: session() })).toBeNull();
  });
});
