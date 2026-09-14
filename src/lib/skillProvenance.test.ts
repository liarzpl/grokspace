import { describe, expect, it } from "vitest";

import { session } from "../test/fixtures";
import type { GraphDocument, GraphNode } from "./graph";
import { lastPlannerGraph, namedSkillsInText, plannerGraphRecipe } from "./skillProvenance";

const SID = "550e8400-e29b-41d4-a716-446655440000";
const planner = (overrides: Parameters<typeof session>[0] = {}) =>
  session({ paneId: null, kind: "agent", title: "Planner", role: "Planner", status: "idle", ...overrides });

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "orch",
    type: "orchestrator",
    label: "Plan it",
    status: "completed",
    position: { x: 0, y: 0 },
    data: {},
    ...overrides,
  };
}

function graph(overrides: Partial<GraphDocument> = {}): GraphDocument {
  return { id: SID, name: "The run", status: "completed", nodes: [node()], edges: [], ...overrides };
}

describe("skill provenance", () => {
  it("names grokspace-graph from update text or a tool line", () => {
    expect(namedSkillsInText("follow grokspace-graph")).toEqual(["grokspace-graph"]);
    expect(namedSkillsInText("Read grokspace-graph SKILL.md")).toEqual(["grokspace-graph"]);
    expect(namedSkillsInText("project-memory then grokspace-steps")).toEqual([
      "grokspace-steps",
      "grokspace-memory",
    ]);
    expect(namedSkillsInText("no skill here")).toEqual([]);
  });

  it("takes the newest Planner graph and ignores a Coder", () => {
    const graphs = {
      c1: { graph: graph({ nodes: [node({ label: "Coder work" })] }), updatedAt: 99 },
      "p-old": { graph: graph({ nodes: [node({ label: "Old plan" })] }), updatedAt: 1 },
      "p-new": { graph: graph({ nodes: [node({ label: "New plan" })] }), updatedAt: 50 },
    };
    expect(
      lastPlannerGraph(
        [
          planner({ id: "c1", role: "Coder", title: "Coder", updatedAt: 99 }),
          planner({ id: "p-old", updatedAt: 1 }),
          planner({ id: "p-new", updatedAt: 50 }),
        ],
        graphs,
      )?.nodes[0]?.label,
    ).toBe("New plan");
    expect(lastPlannerGraph([planner({ id: "c1", role: "Coder" })], graphs)).toBeNull();
  });

  it("uses the user name and $GROKSPACE_* and omits session UUIDs", () => {
    const markdown = plannerGraphRecipe("review-flow", {
      ...graph(),
      nodes: [
        node({ id: SID, data: { artifactPath: `/tmp/acme/.grokspace/graphs/${SID}.json` } }),
        node({ id: "code", type: "agent", label: "Implement" }),
      ],
      edges: [{ id: "e1", source: SID, target: "code", type: "default", animated: false }],
    });
    expect(markdown).toContain("name: review-flow");
    expect(markdown).toContain("$GROKSPACE_GRAPH_FILE");
    expect(markdown).toContain("- Plan it → Implement");
    expect(markdown).not.toContain(SID);
    expect(markdown).not.toContain(".grok/skills");
    expect(markdown).not.toContain("/tmp/acme");
    expect(plannerGraphRecipe("../etc", graph())).toBeNull();
  });
});
