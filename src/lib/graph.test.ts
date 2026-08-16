import { describe, expect, it } from "vitest";

import { inferDirection, parseGraph, statusTally } from "./graph";
import { SAMPLE_GRAPH } from "./graphFixture";

/** Minimal well-formed document; individual tests override the parts they care about. */
function doc(overrides: Record<string, unknown> = {}) {
  return {
    id: "g1",
    name: "Test graph",
    status: "running",
    nodes: [
      { id: "a", type: "orchestrator", label: "A", status: "completed", position: { x: 0, y: 0 } },
      { id: "b", type: "agent", label: "B", status: "running", position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "a", target: "b", type: "smoothstep", animated: true }],
    ...overrides,
  };
}

function expectOk(input: unknown) {
  const result = parseGraph(input);
  if (!result.ok) throw new Error(`expected a parsed graph, got: ${result.error}`);
  return result;
}

describe("parseGraph", () => {
  it("parses the bundled sample without complaint", () => {
    const { graph, warnings } = expectOk(SAMPLE_GRAPH);

    expect(graph.name).toBe("Idea Generation");
    expect(graph.status).toBe("running");
    expect(graph.nodes).toHaveLength(10);
    expect(graph.edges).toHaveLength(12);
    expect(warnings).toEqual([]);
  });

  it("covers every node type and status, so the palette is fully exercised", () => {
    const { graph } = expectOk(SAMPLE_GRAPH);

    expect(new Set(graph.nodes.map((node) => node.type)).size).toBe(8);
    expect(new Set(graph.nodes.map((node) => node.status)).size).toBe(5);
  });

  it("reads nested data and graph state", () => {
    const { graph } = expectOk(SAMPLE_GRAPH);
    const drafting = graph.nodes.find((node) => node.id === "ideas");

    expect(drafting?.data.parallelism).toBe(3);
    expect(drafting?.data.worktree).toBe(true);
    expect(drafting?.data.artifactPath).toBe(".grokspace/graphs/artifacts/drafts/");
    expect(graph.state?.currentLayer).toBe("ideas");
    expect(graph.state?.survivors).toEqual(["idea-3", "idea-7", "idea-9"]);
  });
});

describe("parseGraph tolerance", () => {
  it("draws an unrecognised node type as a plain agent and says so", () => {
    const { graph, warnings } = expectOk(
      doc({
        nodes: [
          { id: "a", type: "wormhole", label: "A", status: "running", position: { x: 0, y: 0 } },
          { id: "b", type: "agent", label: "B", status: "running", position: { x: 200, y: 0 } },
        ],
        edges: [],
      }),
    );

    expect(graph.nodes[0]?.type).toBe("agent");
    expect(warnings.join(" ")).toContain("wormhole");
  });

  it("falls back to pending for an unrecognised status", () => {
    const { graph } = expectOk(
      doc({
        nodes: [
          { id: "a", type: "agent", label: "A", status: "vibing", position: { x: 0, y: 0 } },
          { id: "b", type: "agent", label: "B", status: "running", position: { x: 200, y: 0 } },
        ],
        edges: [],
      }),
    );

    expect(graph.nodes[0]?.status).toBe("pending");
  });

  it("drops an edge naming a node that is not in the graph", () => {
    // React Flow errors outright on a dangling edge, so it must never reach it.
    const { graph, warnings } = expectOk(
      doc({
        edges: [
          { id: "e1", source: "a", target: "b", type: "smoothstep", animated: false },
          { id: "e2", source: "a", target: "ghost", type: "smoothstep", animated: false },
        ],
      }),
    );

    expect(graph.edges.map((edge) => edge.id)).toEqual(["e1"]);
    expect(warnings.join(" ")).toContain("ghost");
  });

  it("skips nodes with no id and duplicate ids", () => {
    const { graph, warnings } = expectOk(
      doc({
        nodes: [
          { id: "a", type: "agent", label: "A", status: "running", position: { x: 0, y: 0 } },
          { type: "agent", label: "No id", status: "running", position: { x: 100, y: 0 } },
          { id: "a", type: "agent", label: "Duplicate", status: "running", position: { x: 200, y: 0 } },
        ],
        edges: [],
      }),
    );

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.label).toBe("A");
    expect(warnings).toHaveLength(2);
  });

  it("keeps the position of a lone node instead of recomputing it", () => {
    const { graph, warnings } = expectOk(
      doc({
        nodes: [{ id: "a", type: "agent", label: "A", status: "running", position: { x: 42, y: 7 } }],
        edges: [],
      }),
    );

    expect(graph.nodes[0]?.position).toEqual({ x: 42, y: 7 });
    expect(warnings).toEqual([]);
  });

  it("falls back to the node id when a label is missing", () => {
    const { graph } = expectOk(
      doc({
        nodes: [{ id: "orch", type: "agent", status: "running", position: { x: 0, y: 0 } }],
        edges: [],
      }),
    );

    expect(graph.nodes[0]?.label).toBe("orch");
  });

  it("keeps the file's positions when they are usable", () => {
    const { graph, warnings } = expectOk(doc());

    expect(graph.nodes.map((node) => node.position.x)).toEqual([0, 200]);
    expect(warnings).toEqual([]);
  });

  it("computes a layout when positions are missing", () => {
    const { graph, warnings } = expectOk(
      doc({
        nodes: [
          { id: "a", type: "orchestrator", label: "A", status: "completed" },
          { id: "b", type: "agent", label: "B", status: "running" },
          { id: "c", type: "agent", label: "C", status: "pending" },
        ],
        edges: [
          { id: "e1", source: "a", target: "b" },
          { id: "e2", source: "b", target: "c" },
        ],
      }),
    );

    const xs = graph.nodes.map((node) => node.position.x);
    expect(new Set(xs).size).toBe(3);
    // Layered by longest path, so each hop moves one column right.
    expect(xs[0]).toBeLessThan(xs[1] ?? 0);
    expect(xs[1] ?? 0).toBeLessThan(xs[2] ?? 0);
    expect(warnings.join(" ")).toContain("positions");
  });

  it("computes a layout when every position is identical", () => {
    // A model that emits all-zero positions is as unusable as one that omits them.
    const { graph } = expectOk(
      doc({
        nodes: [
          { id: "a", type: "agent", label: "A", status: "running", position: { x: 0, y: 0 } },
          { id: "b", type: "agent", label: "B", status: "running", position: { x: 0, y: 0 } },
        ],
      }),
    );

    expect(new Set(graph.nodes.map((node) => node.position.x)).size).toBe(2);
  });

  it("terminates on a cyclic graph rather than looping forever", () => {
    const { graph } = expectOk(
      doc({
        nodes: [
          { id: "a", type: "agent", label: "A", status: "running" },
          { id: "b", type: "agent", label: "B", status: "running" },
        ],
        edges: [
          { id: "e1", source: "a", target: "b" },
          { id: "e2", source: "b", target: "a" },
        ],
      }),
    );

    expect(graph.nodes).toHaveLength(2);
  });

  it("defaults edges to smoothstep, which suits these layered graphs", () => {
    const { graph } = expectOk(doc({ edges: [{ id: "e1", source: "a", target: "b" }] }));

    expect(graph.edges[0]?.type).toBe("smoothstep");
    expect(graph.edges[0]?.animated).toBe(false);
  });
});

describe("parseGraph rejection", () => {
  it.each([
    ["a JSON array", []],
    ["a bare string", "nope"],
    ["null", null],
    ["an object with no nodes array", { name: "x" }],
    ["an object whose nodes are unusable", { nodes: [{ label: "no id" }] }],
  ])("rejects %s with a readable message", (_label, input) => {
    const result = parseGraph(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(10);
  });
});

describe("inferDirection", () => {
  it("reads a wide graph as horizontal", () => {
    const { graph } = expectOk(doc());

    expect(inferDirection(graph.nodes)).toBe("horizontal");
  });

  it("reads a tall graph as vertical", () => {
    const { graph } = expectOk(
      doc({
        nodes: [
          { id: "a", type: "agent", label: "A", status: "running", position: { x: 0, y: 0 } },
          { id: "b", type: "agent", label: "B", status: "running", position: { x: 10, y: 400 } },
        ],
      }),
    );

    expect(inferDirection(graph.nodes)).toBe("vertical");
  });

  it("favours horizontal for a single node, since these graphs read left to right", () => {
    const { graph } = expectOk(
      doc({
        nodes: [{ id: "a", type: "agent", label: "A", status: "running", position: { x: 0, y: 0 } }],
        edges: [],
      }),
    );

    expect(inferDirection(graph.nodes)).toBe("horizontal");
  });
});

describe("statusTally", () => {
  it("counts the sample graph by status", () => {
    const { graph } = expectOk(SAMPLE_GRAPH);

    expect(statusTally(graph.nodes)).toEqual({
      pending: 4,
      running: 1,
      completed: 3,
      failed: 1,
      skipped: 1,
    });
  });
});
