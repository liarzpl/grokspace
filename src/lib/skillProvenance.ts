/**
 * Skill provenance (FEAT-025): display-only chips, plus a Planner graph
 * recipe that is prose + `$GROKSPACE_*` — not a playbook, not a grok install.
 */

import type { Session } from "../types";
import type { GraphDocument, GraphNode } from "./graph";
import { redactPlaybookPaths, sanitizePlaybookName } from "./playbook";

export type NamedSkill = "grokspace-graph" | "grokspace-memory" | "grokspace-steps";

export interface UserSkillRecord {
  name: string;
  path: string;
}

export interface PlannerGraphSlot {
  graph: GraphDocument | null;
  updatedAt?: number | null;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const SKILL_PATTERNS: readonly { name: NamedSkill; pattern: RegExp }[] = [
  { name: "grokspace-graph", pattern: /\bgrokspace-graph\b/i },
  { name: "grokspace-steps", pattern: /\bgrokspace-steps\b/i },
  { name: "grokspace-memory", pattern: /\b(?:grokspace-memory|project-memory)\b/i },
];

export function namedSkillsInText(text: string): NamedSkill[] {
  return SKILL_PATTERNS.filter((row) => row.pattern.test(text)).map((row) => row.name);
}

export function lastPlannerGraph(
  sessions: readonly Session[],
  graphs: Record<string, PlannerGraphSlot>,
): GraphDocument | null {
  const ranked = sessions
    .filter((session) => session.role === "Planner")
    .sort((a, b) => (graphs[b.id]?.updatedAt ?? b.updatedAt) - (graphs[a.id]?.updatedAt ?? a.updatedAt));
  for (const session of ranked) {
    const graph = graphs[session.id]?.graph;
    if (graph != null && graph.nodes.length > 0) return graph;
  }
  return null;
}

export function plannerGraphRecipe(name: string, graph: GraphDocument): string | null {
  const id = sanitizePlaybookName(name);
  if (id === null || graph.nodes.length === 0) return null;
  const labels = new Map<string, string>();
  const nodes = graph.nodes.map((node, index) => {
    const label = nodeLabel(node, index);
    labels.set(node.id, label);
    return `- ${label} (${node.type})`;
  });
  const edges = graph.edges.map((edge) => {
    const via = edge.label?.trim() ? ` — ${edge.label.trim()}` : "";
    return `- ${labels.get(edge.source) ?? "n?"} → ${labels.get(edge.target) ?? "n?"}${via}`;
  });
  const edgeBlock = edges.length > 0 ? ["", "## Edges", ...edges] : [];
  return scrub(
    [
      "---",
      `name: ${id}`,
      "description: Planner graph recipe. Write to $GROKSPACE_GRAPH_FILE.",
      "---",
      "",
      `# ${id}`,
      "",
      "This is a **recipe** (prose + `$GROKSPACE_*` pointers), not a playbook session shape.",
      "Write JSON to **`$GROKSPACE_GRAPH_FILE`**. Do not write `current-graph.json` when that is set, and do not bake a session id or absolute path.",
      "Read `$GROKSPACE_MEMORY_FILE`. Update `$GROKSPACE_STEPS_FILE` when the job has steps.",
      "",
      "## Nodes",
      ...nodes,
      ...edgeBlock,
      "",
    ].join("\n"),
  );
}

function nodeLabel(node: GraphNode, index: number): string {
  const label = node.label.replace(/\s+/g, " ").trim();
  return label === "" ? (UUID.test(node.id) ? `n${index + 1}` : node.id) : label;
}

function scrub(text: string): string {
  return redactPlaybookPaths(text).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<id>",
  );
}
