import { describe, expect, it } from "vitest";

import { appendEdge, overlayLine, overlayRows, parseEdges, type CrossSessionEdge } from "./edges";

const baton: CrossSessionEdge = {
  fromSession: "planner-1",
  fromNode: "plan-root",
  toSession: "coder-1",
  kind: "delegates",
};

describe("parseEdges", () => {
  it("reads a host document and skips a bad row", () => {
    const result = parseEdges({
      edges: [
        baton,
        { fromSession: "a", fromNode: "n", toSession: "b", kind: "depends" },
        { fromSession: "a", fromNode: "n", toSession: "a", kind: "blocks" },
        baton,
      ],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.document.edges).toEqual([baton]);
    expect(result.warnings).toHaveLength(3);
    expect(parseEdges(null).ok).toBe(false);
    expect(parseEdges({ nodes: [] }).ok).toBe(false);
  });
});

describe("overlayRows", () => {
  const incoming: CrossSessionEdge = {
    fromSession: "reviewer-1",
    fromNode: "look",
    toSession: "planner-1",
    kind: "reviews",
  };

  it("lists both directions and names them", () => {
    expect(overlayRows([baton, incoming], "planner-1")).toEqual([
      { edge: baton, direction: "outgoing", otherSession: "coder-1" },
      { edge: incoming, direction: "incoming", otherSession: "reviewer-1" },
    ]);
    expect(
      overlayLine({ edge: baton, direction: "outgoing", otherSession: "coder-1" }, () => "Coder", "Plan"),
    ).toBe("Plan delegates → Coder");
    expect(
      overlayLine({ edge: incoming, direction: "incoming", otherSession: "reviewer-1" }, () => "Reviewer"),
    ).toBe("Reviewer · look reviews this session");
  });
});

describe("appendEdge", () => {
  it("appends one baton edge and is idempotent", () => {
    const once = appendEdge({ edges: [] }, baton);
    if (!once.ok) throw new Error(once.error);
    expect(once.document.edges).toEqual([baton]);
    const twice = appendEdge(once.document, baton);
    if (!twice.ok) throw new Error(twice.error);
    expect(twice.document.edges).toHaveLength(1);
    expect(appendEdge({ edges: [] }, { ...baton, kind: "depends" }).ok).toBe(false);
  });
});
