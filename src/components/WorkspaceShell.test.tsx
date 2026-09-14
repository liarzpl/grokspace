import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHECKPOINT_EQUALS_HEAD, DISCARD_REVERTS_CHECKPOINT } from "../lib/checkpoint";
import { project, session } from "../test/fixtures";

vi.mock("../lib/terminals", () => import("../test/terminalsMock"));

vi.mock("./PaneGrid", () => ({
  default: () => <div data-testid="pane-grid" />,
  LayoutPicker: () => <div data-testid="layout-picker" />,
}));

vi.mock("./GraphVisualizer", () => ({
  default: () => <div data-testid="graph-visualizer" />,
}));

vi.mock("./TaskBoard", () => ({
  default: () => <div data-testid="task-board" />,
}));

vi.mock("./MemoryPanel", () => ({
  default: () => <div data-testid="memory-panel" />,
}));

vi.mock("./DiffPanel", () => ({
  default: () => <div data-testid="diff-panel" />,
}));

vi.mock("./AgentTranscript", () => ({
  default: () => null,
}));

vi.mock("./SessionSteps", () => ({
  default: () => null,
  SessionStepsRail: () => null,
}));

vi.mock("./PermissionActions", () => ({
  PermissionActions: () => null,
}));

const watchProjectGraphs = vi.fn();
const watchProjectSteps = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      watchProjectGraphs,
      watchProjectSteps,
    },
  };
});

const { default: WorkspaceShell } = await import("./WorkspaceShell");
const { useGraphStore } = await import("../stores/graphStore");
const { useMemoryStore } = await import("../stores/memoryStore");
const { useSessionStore } = await import("../stores/sessionStore");
const { useStepStore } = await import("../stores/stepStore");
const { useTaskStore } = await import("../stores/taskStore");
const { useUiStore } = await import("../stores/uiStore");

const initialUi = useUiStore.getState();
const initialSessions = useSessionStore.getState();
const initialTasks = useTaskStore.getState();
const initialMemory = useMemoryStore.getState();
const initialGraph = useGraphStore.getState();
const initialSteps = useStepStore.getState();

describe("WorkspaceShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState(initialUi, true);
    useSessionStore.setState(initialSessions, true);
    useTaskStore.setState(initialTasks, true);
    useMemoryStore.setState(initialMemory, true);
    useGraphStore.setState(initialGraph, true);
    useStepStore.setState(initialSteps, true);
    watchProjectGraphs.mockResolvedValue([]);
    watchProjectSteps.mockResolvedValue([]);
    vi.spyOn(useSessionStore.getState(), "loadSessions").mockResolvedValue();
    vi.spyOn(useTaskStore.getState(), "loadTasks").mockResolvedValue();
    vi.spyOn(useMemoryStore.getState(), "loadMemory").mockResolvedValue();
    vi.spyOn(useGraphStore.getState(), "load").mockResolvedValue();
    vi.spyOn(useStepStore.getState(), "syncSessions").mockResolvedValue();
  });

  it("shows the terminals grid until another tab is chosen", async () => {
    const user = userEvent.setup();
    render(<WorkspaceShell project={project()} />);

    expect(screen.getByTestId("pane-grid")).toBeInTheDocument();
    expect(screen.getByTestId("layout-picker")).toBeInTheDocument();

    await user.click(screen.getByTestId("workspace-tab-graph"));
    expect(useUiStore.getState().tab).toBe("graph");
    expect(await screen.findByTestId("graph-visualizer")).toBeInTheDocument();
    expect(screen.queryByTestId("pane-grid")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("workspace-tab-tasks"));
    expect(await screen.findByTestId("task-board")).toBeInTheDocument();

    await user.click(screen.getByTestId("workspace-tab-memory"));
    expect(screen.getByTestId("memory-panel")).toBeInTheDocument();

    await user.click(screen.getByTestId("workspace-tab-diff"));
    expect(await screen.findByTestId("diff-panel")).toBeInTheDocument();
  });

  it("starts graph and step watches for the open project", async () => {
    render(<WorkspaceShell project={project()} />);

    await waitFor(() => {
      expect(watchProjectGraphs).toHaveBeenCalledWith("p1");
      expect(watchProjectSteps).toHaveBeenCalledWith("p1");
    });
    expect(useSessionStore.getState().loadSessions).toHaveBeenCalledWith("p1");
    expect(useTaskStore.getState().loadTasks).toHaveBeenCalledWith("p1");
    expect(useMemoryStore.getState().loadMemory).toHaveBeenCalledWith("p1");
  });

  it("watches again when the project changes", async () => {
    const { rerender } = render(<WorkspaceShell project={project()} />);
    await waitFor(() => expect(watchProjectGraphs).toHaveBeenCalledWith("p1"));

    rerender(<WorkspaceShell project={project({ id: "p2", name: "other" })} />);

    await waitFor(() => {
      expect(watchProjectGraphs).toHaveBeenCalledWith("p2");
      expect(watchProjectSteps).toHaveBeenCalledWith("p2");
    });
  });

  it("titles Close and Discard with the worktree checkpoint copy", async () => {
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
    useUiStore.setState({ tab: "graph" });

    render(<WorkspaceShell project={project()} />);

    expect(await screen.findByRole("button", { name: "Discard" })).toHaveAttribute(
      "title",
      DISCARD_REVERTS_CHECKPOINT,
    );
    expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute(
      "title",
      CHECKPOINT_EQUALS_HEAD,
    );
  });

  it("surfaces a watch failure on the store the shell already reads", async () => {
    watchProjectGraphs.mockRejectedValue("graph dir missing");
    watchProjectSteps.mockRejectedValue("steps dir missing");

    render(<WorkspaceShell project={project()} />);

    await waitFor(() => {
      expect(useGraphStore.getState().error).toBe("graph dir missing");
      expect(useStepStore.getState().error).toBe("steps dir missing");
    });
  });
});
