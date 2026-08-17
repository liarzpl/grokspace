/**
 * The Graph Engineering document format.
 *
 * These types describe a file written by Grok, not a Rust struct, which is why
 * they live here rather than in src/types.ts. Because a model writes the file,
 * `parseGraph` is deliberately forgiving: it would rather render a slightly
 * degraded graph than refuse to draw anything.
 */

export const GRAPH_STATUSES = ["pending", "running", "completed", "failed", "partial"] as const;
export type GraphStatus = (typeof GRAPH_STATUSES)[number];

/** Node status has `skipped`, which the graph as a whole does not. */
export const NODE_STATUSES = ["pending", "running", "completed", "failed", "skipped"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const NODE_TYPES = [
  "orchestrator",
  "agent",
  "parallel-group",
  "arena",
  "verifier",
  "human-gate",
  "synthesizer",
  "tool",
] as const;
export type GraphNodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = ["default", "smoothstep", "step", "straight"] as const;
export type GraphEdgeType = (typeof EDGE_TYPES)[number];

export interface GraphNodeData {
  description?: string;
  model?: string;
  effort?: string;
  parallelism?: number;
  worktree?: boolean;
  artifactPath?: string;
}

export interface Position {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  status: NodeStatus;
  role?: string;
  position: Position;
  data: GraphNodeData;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  type: GraphEdgeType;
  animated: boolean;
}

export interface GraphState {
  currentLayer?: string;
  notes?: string;
  partial?: boolean;
  survivors?: string[];
}

export interface GraphDocument {
  id: string;
  name: string;
  status: GraphStatus;
  createdAt?: string;
  updatedAt?: string;
  topology?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  state?: GraphState;
}

export type ParseResult =
  | { ok: true; graph: GraphDocument; warnings: string[] }
  | { ok: false; error: string };

/** Spacing used only when the file did not supply usable positions. */
const LAYOUT_COLUMN = 260;
const LAYOUT_ROW = 120;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function parseData(record: Record<string, unknown> | null): GraphNodeData {
  if (!record) return {};
  return {
    description: asString(record["description"]),
    model: asString(record["model"]),
    effort: asString(record["effort"]),
    parallelism: asNumber(record["parallelism"]),
    worktree: typeof record["worktree"] === "boolean" ? record["worktree"] : undefined,
    artifactPath: asString(record["artifactPath"]),
  };
}

/** A node before layout has run; the file may not have given it a position. */
type UnplacedNode = Omit<GraphNode, "position"> & { position?: Position };

/**
 * Assigns positions by longest-path layering. Only used when the file's own
 * positions are unusable, which otherwise leaves every node stacked at the
 * origin and looks like a rendering bug.
 */
function layeredPositions(nodes: UnplacedNode[], edges: GraphEdge[]): Map<string, Position> {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) {
    depth.set(node.id, 0);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    incoming.get(edge.target)?.push(edge.source);
  }

  // Relax depths until stable. The pass cap means a cyclic graph settles instead
  // of looping forever.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const node of nodes) {
      const deepestParent = (incoming.get(node.id) ?? []).reduce(
        (deepest, source) => Math.max(deepest, (depth.get(source) ?? 0) + 1),
        0,
      );
      if (deepestParent > (depth.get(node.id) ?? 0)) {
        depth.set(node.id, deepestParent);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const byLayer = new Map<number, string[]>();
  for (const node of nodes) {
    const layer = depth.get(node.id) ?? 0;
    const members = byLayer.get(layer);
    if (members) members.push(node.id);
    else byLayer.set(layer, [node.id]);
  }

  const positions = new Map<string, Position>();
  for (const [layer, members] of byLayer) {
    members.forEach((id, index) => {
      positions.set(id, {
        x: layer * LAYOUT_COLUMN,
        // Centre each layer so the graph reads down the middle.
        y: (index - (members.length - 1) / 2) * LAYOUT_ROW,
      });
    });
  }
  return positions;
}

function place(nodes: UnplacedNode[], edges: GraphEdge[], warnings: string[]): GraphNode[] {
  const placed = nodes.filter((node) => node.position !== undefined);
  const distinct = new Set(placed.map((node) => `${node.position?.x},${node.position?.y}`));
  // All-identical positions are as useless as no positions at all, though a lone
  // node cannot be stacked on anything and so is always fine as given.
  const usable =
    placed.length === nodes.length && (nodes.length === 1 || distinct.size > 1);

  if (usable) {
    return nodes.map((node) => ({ ...node, position: node.position ?? { x: 0, y: 0 } }));
  }

  // Warned about only when the file tried and produced something unusable — some nodes
  // placed and others not, or every node on the same spot. A file with no positions at
  // all is following the skill, which asks agents to omit them: layering here can see
  // how many nodes landed in each column and a formula in a prompt cannot, so that
  // graph is not degraded and saying it is would train people to ignore the warnings.
  if (placed.length > 0) {
    warnings.push(
      "Some node positions were unusable, so the whole layout was computed instead.",
    );
  }
  const computed = layeredPositions(nodes, edges);
  return nodes.map((node) => ({ ...node, position: computed.get(node.id) ?? { x: 0, y: 0 } }));
}

export function parseGraph(input: unknown): ParseResult {
  const root = asRecord(input);
  if (!root) {
    return { ok: false, error: "The graph file does not contain a JSON object." };
  }
  if (!Array.isArray(root["nodes"])) {
    return { ok: false, error: "The graph file has no `nodes` array." };
  }

  const warnings: string[] = [];
  const unknownTypes = new Set<string>();
  const unplaced: UnplacedNode[] = [];
  const ids = new Set<string>();

  for (const raw of root["nodes"]) {
    const record = asRecord(raw);
    const id = record ? asString(record["id"]) : undefined;
    if (!record || !id) {
      warnings.push("Skipped a node with no id.");
      continue;
    }
    if (ids.has(id)) {
      warnings.push(`Skipped a second node using the id "${id}".`);
      continue;
    }
    ids.add(id);

    const declaredType = record["type"];
    if (
      typeof declaredType === "string" &&
      !(NODE_TYPES as readonly string[]).includes(declaredType)
    ) {
      unknownTypes.add(declaredType);
    }

    const position = asRecord(record["position"]);
    const x = position ? asNumber(position["x"]) : undefined;
    const y = position ? asNumber(position["y"]) : undefined;

    unplaced.push({
      id,
      type: oneOf(NODE_TYPES, declaredType, "agent"),
      label: asString(record["label"]) ?? id,
      status: oneOf(NODE_STATUSES, record["status"], "pending"),
      role: asString(record["role"]),
      position: x !== undefined && y !== undefined ? { x, y } : undefined,
      data: parseData(asRecord(record["data"])),
    });
  }

  if (unplaced.length === 0) {
    return { ok: false, error: "The graph file contains no usable nodes." };
  }
  if (unknownTypes.size > 0) {
    warnings.push(
      `Drew as a plain agent: unrecognised node type ${[...unknownTypes].map((type) => `"${type}"`).join(", ")}.`,
    );
  }

  const edges: GraphEdge[] = [];
  const rawEdges = Array.isArray(root["edges"]) ? root["edges"] : [];
  for (const raw of rawEdges) {
    const record = asRecord(raw);
    const source = record ? asString(record["source"]) : undefined;
    const target = record ? asString(record["target"]) : undefined;
    if (!record || !source || !target) {
      warnings.push("Skipped an edge missing its source or target.");
      continue;
    }
    if (!ids.has(source) || !ids.has(target)) {
      // React Flow errors on an edge naming a node it cannot find.
      warnings.push(`Skipped edge ${source} to ${target}: one end is not in the graph.`);
      continue;
    }
    edges.push({
      id: asString(record["id"]) ?? `${source}->${target}`,
      source,
      target,
      label: asString(record["label"]),
      // smoothstep rather than the schema's `default`, which reads better for
      // the layered graphs this format produces.
      type: oneOf(EDGE_TYPES, record["type"], "smoothstep"),
      animated: record["animated"] === true,
    });
  }

  const state = asRecord(root["state"]);
  const survivors = state && Array.isArray(state["survivors"]) ? state["survivors"] : undefined;

  return {
    ok: true,
    warnings,
    graph: {
      id: asString(root["id"]) ?? "graph",
      name: asString(root["name"]) ?? "Untitled graph",
      status: oneOf(GRAPH_STATUSES, root["status"], "pending"),
      createdAt: asString(root["createdAt"]),
      updatedAt: asString(root["updatedAt"]),
      topology: asString(root["topology"]),
      nodes: place(unplaced, edges, warnings),
      edges,
      ...(state
        ? {
            state: {
              currentLayer: asString(state["currentLayer"]),
              notes: asString(state["notes"]),
              partial: state["partial"] === true,
              survivors: survivors?.filter((value): value is string => typeof value === "string"),
            },
          }
        : {}),
    },
  };
}

export type FlowDirection = "horizontal" | "vertical";

/**
 * Works out which way the graph flows so node handles sit on the right edges.
 * Guessing wrong makes every edge loop back on itself. Ties favour horizontal,
 * since these graphs are usually written to read left to right.
 */
export function inferDirection(nodes: GraphNode[]): FlowDirection {
  if (nodes.length < 2) return "horizontal";
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const horizontal = spread(nodes.map((node) => node.position.x));
  const vertical = spread(nodes.map((node) => node.position.y));
  return vertical > horizontal * 1.5 ? "vertical" : "horizontal";
}

/** Node counts by status, for the panel header. */
export function statusTally(nodes: GraphNode[]): Record<NodeStatus, number> {
  const tally: Record<NodeStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
  };
  for (const node of nodes) tally[node.status] += 1;
  return tally;
}
