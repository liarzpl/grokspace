import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { FlowDirection, GraphNode, GraphNodeType, NodeStatus } from "../../lib/graph";

/**
 * A type alias rather than an interface: React Flow requires node data to be
 * assignable to `Record<string, unknown>`, which interfaces are not.
 */
export type FlowNodeData = {
  node: GraphNode;
  direction: FlowDirection;
};

export type GraphFlowNode = Node<FlowNodeData, "graphNode">;

/**
 * Type is carried by a short badge and an accent colour rather than by an icon,
 * which keeps the graph consistent with the rest of the app's typography-led
 * styling and avoids pulling in an icon set.
 */
const TYPE_META: Record<GraphNodeType, { badge: string; accent: string }> = {
  orchestrator: { badge: "ORCH", accent: "text-accent" },
  agent: { badge: "AGENT", accent: "text-ink-muted" },
  "parallel-group": { badge: "PAR", accent: "text-cyan-300" },
  arena: { badge: "ARENA", accent: "text-fuchsia-300" },
  verifier: { badge: "VERIFY", accent: "text-success" },
  "human-gate": { badge: "GATE", accent: "text-warning" },
  synthesizer: { badge: "SYNTH", accent: "text-indigo-300" },
  tool: { badge: "TOOL", accent: "text-ink-faint" },
};

export const STATUS_META: Record<NodeStatus, { label: string; border: string; dot: string }> = {
  pending: { label: "Pending", border: "border-line-strong", dot: "bg-ink-faint" },
  running: { label: "Running", border: "border-accent animate-node-pulse", dot: "bg-accent" },
  completed: { label: "Completed", border: "border-success/60", dot: "bg-success" },
  failed: { label: "Failed", border: "border-danger/70", dot: "bg-danger" },
  skipped: { label: "Skipped", border: "border-line", dot: "bg-ink-faint" },
};

export default function GraphNodeCard({ data, selected }: NodeProps<GraphFlowNode>) {
  const { node, direction } = data;
  const type = TYPE_META[node.type];
  const status = STATUS_META[node.status];

  const handleClass = "size-1.5! border-0! bg-line-strong!";

  return (
    <>
      <Handle
        type="target"
        position={direction === "horizontal" ? Position.Left : Position.Top}
        className={handleClass}
      />

      <div
        className={`w-[188px] rounded-lg border bg-panel px-2.5 py-2 transition-shadow ${status.border} ${
          // A gate is the one node type that stops and waits for a person, so it
          // reads as an interruption rather than as work in progress.
          node.type === "human-gate" ? "border-dashed" : ""
        } ${node.status === "skipped" ? "opacity-45" : ""} ${
          selected ? "ring-1 ring-accent" : ""
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span className={`size-1.5 shrink-0 rounded-full ${status.dot}`} />
          <span
            className={`font-mono text-[9px] font-semibold tracking-widest ${type.accent}`}
            title={node.type}
          >
            {type.badge}
          </span>
          <span className="flex-1" />
          {node.data.parallelism !== undefined && (
            <span className="font-mono text-[9px] text-ink-faint" title="Parallelism">
              x{node.data.parallelism}
            </span>
          )}
          {node.data.worktree === true && (
            <span className="font-mono text-[9px] text-ink-faint" title="Runs in a git worktree">
              wt
            </span>
          )}
        </div>

        <p className="mt-1 truncate text-[12px] leading-tight font-medium text-ink">{node.label}</p>
        {node.role !== undefined && (
          <p className="mt-0.5 truncate text-[10px] text-ink-faint">{node.role}</p>
        )}
      </div>

      <Handle
        type="source"
        position={direction === "horizontal" ? Position.Right : Position.Bottom}
        className={handleClass}
      />
    </>
  );
}
