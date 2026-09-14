import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../types";

const listProjects = vi.fn();
const openProject = vi.fn();
const touchProject = vi.fn();
const updateProject = vi.fn();
const removeProject = vi.fn();
const listSessions = vi.fn();

vi.mock("../lib/terminals", () => ({ disposeTerminal: vi.fn(), detachTerminal: vi.fn() }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      listProjects,
      openProject,
      touchProject,
      updateProject,
      removeProject,
      listSessions,
    },
  };
});

const { disposeTerminal } = await import("../lib/terminals");
const { useGraphStore } = await import("./graphStore");
const { useSessionStore } = await import("./sessionStore");
const { useUiStore } = await import("./uiStore");
const { layoutOf, useProjectStore } = await import("./projectStore");

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "acme-api",
    path: "/Users/dev/acme-api",
    lastOpened: 1000,
    settings: {},
    createdAt: 1000,
    ...overrides,
  };
}

const initialState = useProjectStore.getState();
const initialSessions = useSessionStore.getState();
const initialGraphs = useGraphStore.getState();
const initialUi = useUiStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState(initialState, true);
  useSessionStore.setState(initialSessions, true);
  useGraphStore.setState(initialGraphs, true);
  useUiStore.setState(initialUi, true);
  listSessions.mockResolvedValue([]);
});

describe("loadProjects", () => {
  it("sorts by recency and selects the most recent project", async () => {
    listProjects.mockResolvedValue([
      project({ id: "old", name: "old", lastOpened: 100 }),
      project({ id: "new", name: "new", lastOpened: 900 }),
    ]);

    await useProjectStore.getState().loadProjects();

    const state = useProjectStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(["new", "old"]);
    expect(state.activeProjectId).toBe("new");
    expect(state.isLoading).toBe(false);
  });

  it("keeps an existing selection when reloading", async () => {
    listProjects.mockResolvedValue([
      project({ id: "a", lastOpened: 900 }),
      project({ id: "b", lastOpened: 100 }),
    ]);
    useProjectStore.setState({ activeProjectId: "b" });

    await useProjectStore.getState().loadProjects();

    expect(useProjectStore.getState().activeProjectId).toBe("b");
  });

  it("surfaces backend errors instead of throwing", async () => {
    listProjects.mockRejectedValue("database is locked");

    await useProjectStore.getState().loadProjects();

    const state = useProjectStore.getState();
    expect(state.error).toBe("database is locked");
    expect(state.isLoading).toBe(false);
  });
});

describe("pickAndOpenProject", () => {
  it("opens the folder chosen in the picker and makes it active", async () => {
    openProject.mockResolvedValue(project());

    const opened = await useProjectStore.getState().pickAndOpenProject();

    expect(openProject).toHaveBeenCalledWith();
    expect(opened?.id).toBe("p1");
    expect(useProjectStore.getState().activeProjectId).toBe("p1");
  });

  it("does nothing when the picker is cancelled", async () => {
    openProject.mockResolvedValue(null);

    const opened = await useProjectStore.getState().pickAndOpenProject();

    expect(opened).toBeNull();
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(useProjectStore.getState().isOpening).toBe(false);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("reopening a known project updates it in place rather than duplicating it", async () => {
    useProjectStore.setState({ projects: [project({ lastOpened: 1000 })] });
    openProject.mockResolvedValue(project({ lastOpened: 5000 }));

    await useProjectStore.getState().pickAndOpenProject();

    const { projects } = useProjectStore.getState();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.lastOpened).toBe(5000);
  });

  it("surfaces a refused folder instead of throwing", async () => {
    openProject.mockRejectedValue("`/Users/dev` cannot be opened as a project");

    const opened = await useProjectStore.getState().pickAndOpenProject();

    expect(opened).toBeNull();
    expect(useProjectStore.getState().error).toBe(
      "`/Users/dev` cannot be opened as a project",
    );
    expect(useProjectStore.getState().isOpening).toBe(false);
  });
});

describe("selectProject", () => {
  it("switches immediately and reorders once the backend confirms", async () => {
    useProjectStore.setState({
      projects: [project({ id: "a", name: "a", lastOpened: 900 }), project({ id: "b", name: "b", lastOpened: 100 })],
      activeProjectId: "a",
    });
    touchProject.mockResolvedValue(project({ id: "b", name: "b", lastOpened: 9000 }));

    await useProjectStore.getState().selectProject("b");

    const state = useProjectStore.getState();
    expect(state.activeProjectId).toBe("b");
    expect(state.projects.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("renameProject", () => {
  it("replaces the project with the renamed one the backend returns", async () => {
    useProjectStore.setState({ projects: [project({ name: "acme-api" })] });
    updateProject.mockResolvedValue(project({ name: "acme" }));

    await useProjectStore.getState().renameProject("p1", "acme");

    expect(updateProject).toHaveBeenCalledWith("p1", { name: "acme" });
    expect(useProjectStore.getState().projects[0]?.name).toBe("acme");
  });

  it("leaves the old name in place when the backend refuses the new one", async () => {
    useProjectStore.setState({ projects: [project({ name: "acme-api" })] });
    updateProject.mockRejectedValue("a project needs a name");

    await useProjectStore.getState().renameProject("p1", "   ");

    const state = useProjectStore.getState();
    expect(state.error).toBe("a project needs a name");
    expect(state.projects[0]?.name).toBe("acme-api");
  });
});

describe("setLayout", () => {
  it("writes only the typed layout field", async () => {
    useProjectStore.setState({
      projects: [project({ settings: { terminalLayout: "2x2" } })],
    });
    updateProject.mockResolvedValue(project({ settings: { terminalLayout: "3x2" } }));

    await useProjectStore.getState().setLayout("p1", "3x2");

    expect(updateProject).toHaveBeenCalledWith("p1", {
      settings: { terminalLayout: "3x2" },
    });
    expect(layoutOf(useProjectStore.getState().projects[0] ?? null)).toBe("3x2");
  });

  it("does nothing for a project it has never heard of", async () => {
    // The layout is read off the project in hand, so there is nothing to merge into.
    await useProjectStore.getState().setLayout("missing", "1x1");

    expect(updateProject).not.toHaveBeenCalled();
  });
});

describe("forgetProject", () => {
  it("removes the project and falls back to the next most recent one", async () => {
    useProjectStore.setState({
      projects: [project({ id: "a", lastOpened: 900 }), project({ id: "b", lastOpened: 100 })],
      activeProjectId: "a",
    });
    removeProject.mockResolvedValue(undefined);

    await useProjectStore.getState().forgetProject("a");

    const state = useProjectStore.getState();
    expect(state.projects.map((p) => p.id)).toEqual(["b"]);
    expect(state.activeProjectId).toBe("b");
  });

  it("clears the selection when the last project is forgotten", async () => {
    useProjectStore.setState({ projects: [project({ id: "a" })], activeProjectId: "a" });
    removeProject.mockResolvedValue(undefined);

    await useProjectStore.getState().forgetProject("a");

    expect(useProjectStore.getState().activeProjectId).toBeNull();
  });

  it("disposes terminals for the forgotten project's sessions before removing it", async () => {
    listSessions.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
    useProjectStore.setState({
      projects: [project({ id: "a" })],
      activeProjectId: "a",
    });
    useSessionStore.setState({ sessions: [{ id: "s1" } as never] });
    useUiStore.setState({
      paneViews: { "0": "graph" },
      maximizedPane: "0",
      permissions: { s1: [{ requestId: 1, summary: "x" }] },
    });
    removeProject.mockResolvedValue(undefined);

    await useProjectStore.getState().forgetProject("a");

    expect(listSessions).toHaveBeenCalledWith("a");
    expect(disposeTerminal).toHaveBeenCalledWith("s1");
    expect(disposeTerminal).toHaveBeenCalledWith("s2");
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useUiStore.getState().permissions).toEqual({});
    expect(useUiStore.getState().paneViews).toEqual({});
    expect(useUiStore.getState().maximizedPane).toBeNull();
    expect(removeProject).toHaveBeenCalledWith("a");
  });
});

describe("layoutOf", () => {
  it("reads the typed terminalLayout field", () => {
    expect(layoutOf(project({ settings: { terminalLayout: "1x1" } }))).toBe("1x1");
  });

  it("falls back when the stored layout is not a pane layout", () => {
    expect(
      layoutOf(project({ settings: { terminalLayout: "9x9" as Project["settings"]["terminalLayout"] } })),
    ).toBe("2x2");
  });
});
