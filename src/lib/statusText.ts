import type { GraphNode, GraphStatus, NodeStatus } from "./graph";
import type { SessionStatus } from "../types";

/** Visible / announced names for graph node status. Dots stay decorative. */
export const NODE_STATUS_LABELS: Record<NodeStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

export function nodeStatusLabel(status: NodeStatus): string {
  return NODE_STATUS_LABELS[status] ?? NODE_STATUS_LABELS.pending;
}

/** Label plus status, so a node is named without relying on colour. */
export function graphNodeA11yLabel(node: Pick<GraphNode, "label" | "status">): string {
  return `${node.label}, ${nodeStatusLabel(node.status)}`;
}

export function sessionStatusPhrase(status: SessionStatus): string {
  return status === "needs_input" ? "needs input" : status;
}

/** e.g. "Pane 1, running" — process state as text, not only a colour dot. */
export function paneA11yLabel(title: string, status: SessionStatus): string {
  return `${title}, ${sessionStatusPhrase(status)}`;
}

export function graphStatusPhrase(
  error: boolean,
  status: GraphStatus | undefined,
): string {
  if (error) return "graph unreadable";
  if (status !== undefined) return `graph ${status}`;
  return "no graph yet";
}

export function sessionChipA11yLabel(
  name: string,
  status: SessionStatus,
  graph: { error: boolean; status?: GraphStatus },
): string {
  return `${name}, ${sessionStatusPhrase(status)}, ${graphStatusPhrase(graph.error, graph.status)}`;
}
