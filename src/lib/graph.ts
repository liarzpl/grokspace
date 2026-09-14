/**
 * The Graph Engineering document format.
 *
 * These types describe a file written by Grok, not a Rust struct, which is why
 * they live here rather than in src/types.ts. Because a model writes the file,
 * `parseGraph` is deliberately forgiving: it would rather render a slightly
 * degraded graph than refuse to draw anything.
 */

import { MAX_STEPS } from "./limits";

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

/** Runtime notes on the document itself — not the Zustand store. */
export interface GraphDocState {
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
  state?: GraphDocState;
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

/**
 * Host lock of graph node labels at Build. This is not a field on the agent's
 * file and must not be written back into `$GROKSPACE_GRAPH_FILE`.
 */
export interface GraphTitleStamp {
  titles: Readonly<Record<string, string>>;
}

export function stampGraphTitles(graph: GraphDocument): GraphTitleStamp {
  const titles: Record<string, string> = {};
  for (const node of graph.nodes) titles[node.id] = node.label;
  return { titles };
}

/**
 * After Build, ingest keeps stamped titles. Status and the rest of the node may
 * move. New or rewritten titles are a revise-plan signal; they do not replace
 * the stamp.
 */
export function ingestLockedGraph(
  incoming: GraphDocument,
  stamp: GraphTitleStamp,
): { graph: GraphDocument; revisedTitles: boolean } {
  const incomingIds = new Set<string>();
  let revisedTitles = false;
  let labelsMoved = false;

  const nodes = incoming.nodes.map((node) => {
    incomingIds.add(node.id);
    const locked = stamp.titles[node.id];
    if (locked === undefined) {
      revisedTitles = true;
      return node;
    }
    if (node.label === locked) return node;
    revisedTitles = true;
    labelsMoved = true;
    return { ...node, label: locked };
  });

  for (const id of Object.keys(stamp.titles)) {
    if (!incomingIds.has(id)) revisedTitles = true;
  }

  return {
    graph: labelsMoved ? { ...incoming, nodes } : incoming,
    revisedTitles,
  };
}

/** First lock wins so a later drifted file cannot restamp. */
const titleStamps = new Map<string, GraphTitleStamp>();

export function graphTitleStampFor(sessionId: string): GraphTitleStamp | undefined {
  return titleStamps.get(sessionId);
}

export function lockGraphTitles(
  sessionId: string,
  graph: GraphDocument | null,
): GraphTitleStamp | undefined {
  const existing = titleStamps.get(sessionId);
  if (existing !== undefined) return existing;
  if (graph === null) return undefined;
  const stamp = stampGraphTitles(graph);
  titleStamps.set(sessionId, stamp);
  return stamp;
}

export function unlockGraphTitles(sessionId: string): void {
  titleStamps.delete(sessionId);
}

/** Drops every session stamp. Tests only. */
export function resetGraphTitleStamps(): void {
  titleStamps.clear();
}

/** Nodes reachable by outgoing edges, not including `fromId`. */
export function descendantNodeIds(edges: readonly GraphEdge[], fromId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const list = children.get(edge.source);
    if (list) list.push(edge.target);
    else children.set(edge.source, [edge.target]);
  }
  const seen = new Set<string>();
  const queue = [fromId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) break;
    for (const next of children.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

export interface ForkedGraph {
  graph: GraphDocument;
  /** Old node id → reminted id, so the copy cannot collide with the parent. */
  idMap: Readonly<Record<string, string>>;
}

/** Remint ids; `nodeId` running, descendants pending. Missing node → null. */
export function forkGraphFromNode(
  graph: GraphDocument,
  nodeId: string,
  mintId: () => string = () => crypto.randomUUID(),
): ForkedGraph | null {
  if (!graph.nodes.some((node) => node.id === nodeId)) return null;

  const descendants = descendantNodeIds(graph.edges, nodeId);
  const idMap: Record<string, string> = {};
  for (const node of graph.nodes) idMap[node.id] = mintId();

  const nodes = graph.nodes.map((node) => {
    let status = node.status;
    if (node.id === nodeId) status = "running";
    else if (descendants.has(node.id)) status = "pending";
    return { ...node, id: idMap[node.id] ?? node.id, status, data: { ...node.data } };
  });

  const edges = graph.edges.map((edge) => ({
    ...edge,
    id: mintId(),
    source: idMap[edge.source] ?? edge.source,
    target: idMap[edge.target] ?? edge.target,
  }));

  const state = graph.state
    ? {
        ...graph.state,
        currentLayer:
          graph.state.currentLayer !== undefined
            ? (idMap[graph.state.currentLayer] ?? graph.state.currentLayer)
            : undefined,
        survivors: graph.state.survivors
          ?.map((id) => idMap[id])
          .filter((id): id is string => id !== undefined),
      }
    : undefined;

  return {
    idMap,
    graph: {
      ...graph,
      id: mintId(),
      status: "running",
      nodes,
      edges,
      ...(state ? { state } : {}),
    },
  };
}

export interface GraphStepMismatch {
  nodeId: string;
  nodeLabel: string;
  stepTitle: string;
}

/** How the graph's labels/ids disagree with the step titles. Layout is ignored. */
export interface GraphStepsDrift {
  extraNodes: { id: string; label: string }[];
  extraSteps: string[];
  mismatched: GraphStepMismatch[];
}

function driftKey(value: string): string {
  return value.trim();
}

/**
 * Compare graph node labels/ids to step titles. Positions, edges, and status
 * do not count. Both sides empty is not drift. Each side is capped at
 * `MAX_STEPS` so a large graph cannot outshout the checklist.
 */
export function graphStepsDrift(
  nodes: readonly Pick<GraphNode, "id" | "label">[],
  steps: readonly { title: string }[],
): GraphStepsDrift | null {
  const cappedNodes = nodes.slice(0, MAX_STEPS);
  const cappedSteps = steps.slice(0, MAX_STEPS);
  if (cappedNodes.length === 0 && cappedSteps.length === 0) return null;

  const usedNodes = new Set<number>();
  const usedSteps = new Set<number>();

  const takeMatch = (title: string, byId: boolean): number => {
    return cappedNodes.findIndex((node, index) => {
      if (usedNodes.has(index)) return false;
      const key = byId ? driftKey(node.id) : driftKey(node.label);
      return key === title;
    });
  };

  for (let index = 0; index < cappedSteps.length; index += 1) {
    const title = driftKey(cappedSteps[index]?.title ?? "");
    if (title === "") continue;
    const match = takeMatch(title, false);
    if (match >= 0) {
      usedNodes.add(match);
      usedSteps.add(index);
    }
  }
  for (let index = 0; index < cappedSteps.length; index += 1) {
    if (usedSteps.has(index)) continue;
    const title = driftKey(cappedSteps[index]?.title ?? "");
    if (title === "") continue;
    const match = takeMatch(title, true);
    if (match >= 0) {
      usedNodes.add(match);
      usedSteps.add(index);
    }
  }

  const leftoverNodes = cappedNodes.filter((_, index) => !usedNodes.has(index));
  const leftoverSteps = cappedSteps.filter((_, index) => !usedSteps.has(index));
  const paired = Math.min(leftoverNodes.length, leftoverSteps.length);

  const mismatched: GraphStepMismatch[] = [];
  for (let index = 0; index < paired; index += 1) {
    const node = leftoverNodes[index];
    const step = leftoverSteps[index];
    if (node === undefined || step === undefined) continue;
    mismatched.push({ nodeId: node.id, nodeLabel: node.label, stepTitle: step.title });
  }

  const extraNodes = leftoverNodes.slice(paired).map((node) => ({ id: node.id, label: node.label }));
  const extraSteps = leftoverSteps.slice(paired).map((step) => step.title);
  if (mismatched.length === 0 && extraNodes.length === 0 && extraSteps.length === 0) {
    return null;
  }
  return { extraNodes, extraSteps, mismatched };
}

/** One rail line. Caps the named items so a 20-wide mismatch stays readable. */
export function graphStepsDriftMessage(drift: GraphStepsDrift): string {
  const bits: string[] = [];
  for (const item of drift.mismatched) {
    bits.push(`${item.nodeLabel} vs ${item.stepTitle}`);
  }
  for (const node of drift.extraNodes) {
    bits.push(`extra graph node ${node.label}`);
  }
  for (const title of drift.extraSteps) {
    bits.push(`extra step ${title}`);
  }
  const shown = bits.slice(0, 3);
  const more = bits.length - shown.length;
  const detail = more > 0 ? `${shown.join("; ")}; +${more} more` : shown.join("; ");
  return `Graph and steps differ: ${detail}.`;
}
