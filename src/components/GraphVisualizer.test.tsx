import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { session } from "../test/fixtures";
import type { GraphDocument } from "../lib/graph";
import type { SessionStep } from "../types";

vi.mock("@xyflow/react", () => ({
  ReactFlow: () => <div data-testid="react-flow" />,
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

const reopenSessionSteps = vi.fn();

const readSessionPermissionHeat = vi.fn().mockResolvedValue({
  path: "/p/.grokspace/graphs/s1.permissions.json",
  asks: [
    { requestId: 1, summary: "Edit a", chip: "allow_once", stepId: "a" },
    { requestId: 2, summary: "Edit b", chip: "deny", stepId: null },
  ],
});

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: { skillStatus: vi.fn(), reopenSessionSteps, readSessionPermissionHeat },
  };
});

const { default: GraphVisualizer } = await import("./GraphVisualizer");
const { parseGraph, resetGraphTitleStamps } = await import("../lib/graph");
const { useGraphStore } = await import("../stores/graphStore");
const { useStepStore } = await import("../stores/stepStore");

function graph(a: string, b: string, aStatus = "completed", bStatus = "running"): GraphDocument {
  const result = parseGraph({
    id: "g1",
    name: "Test",
    status: "running",
    nodes: [
      { id: "a", type: "orchestrator", label: a, status: aStatus, position: { x: 0, y: 0 } },
      { id: "b", type: "agent", label: b, status: bStatus, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "a", target: "b" }],
  });
  if (!result.ok) throw new Error(result.error);
  return result.graph;
}

function seed(doc: GraphDocument, phase: "proposed" | "approved") {
  const step: SessionStep = {
    id: "a",
    sessionId: "s1",
    sortIndex: 0,
    title: "Read auth.ts",
    status: "pending",
    origin: "agent",
    createdAt: 1,
    updatedAt: 1,
  };
  useGraphStore.setState({
    bySession: {
      s1: {
        path: "/p/.grokspace/graphs/s1.json",
        graph: doc,
        warnings: [],
        error: null,
        updatedAt: 1,
        bytes: 10,
        isLoading: false,
      },
    },
  });
  useStepStore.setState({
    bySession: { s1: { sessionId: "s1", phase, steps: [step], isLoading: false } },
  });
}

const initialGraph = useGraphStore.getState();
const initialSteps = useStepStore.getState();

describe("GraphVisualizer title stamp", () => {
  beforeEach(() => {
    useGraphStore.setState(initialGraph, true);
    useStepStore.setState(initialSteps, true);
    resetGraphTitleStamps();
  });

  it("after Build, ingest keeps titles and lets status move", async () => {
    seed(graph("A", "B"), "approved");
    render(<GraphVisualizer session={session()} compact />);
    await waitFor(() => expect(screen.getByRole("option", { name: "A, Completed" })).toBeInTheDocument());

    seed(graph("Renamed A", "Renamed B", "running", "completed"), "approved");

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "A, Running" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "B, Completed" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("option", { name: "Renamed A, Running" })).not.toBeInTheDocument();
    expect(screen.getByText(/Reopen Spec to revise the plan/)).toBeInTheDocument();

    reopenSessionSteps.mockResolvedValue({
      sessionId: "s1",
      phase: "proposed",
      steps: [],
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Reopen Spec" }));
    await waitFor(() => expect(reopenSessionSteps).toHaveBeenCalledWith("s1"));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Renamed A, Running" })).toBeInTheDocument(),
    );
  });

  it("while Spec, new titles draw", async () => {
    seed(graph("A", "B"), "proposed");
    render(<GraphVisualizer session={session()} compact />);
    await waitFor(() => expect(screen.getByRole("option", { name: "A, Completed" })).toBeInTheDocument());

    seed(graph("Renamed A", "Renamed B", "running", "completed"), "proposed");

    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Renamed A, Running" })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Reopen Spec to revise the plan/)).not.toBeInTheDocument();
  });

  it("shows a count badge and does not colour it as trust", async () => {
    seed(graph("A", "B"), "proposed");
    render(<GraphVisualizer session={session()} compact />);
    const badge = await screen.findByTestId("permission-heat-badge");
    expect(badge).toHaveTextContent("2 permission answers");
    expect(badge.className).not.toMatch(/text-success|text-danger|text-warning|bg-success|bg-danger/);
    expect(readSessionPermissionHeat).toHaveBeenCalledWith("s1");
  });
});
