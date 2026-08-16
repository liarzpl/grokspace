import { useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import { inferDirection, type GraphDocument, type NodeStatus } from "../lib/graph";
import GraphNodeCard, { type GraphFlowNode } from "./graph/GraphNode";
import NodeInspector from "./graph/NodeInspector";

/** Module scope on purpose: React Flow warns when this object's identity changes. */
const nodeTypes = { graphNode: GraphNodeCard };

const MINIMAP_COLOR: Record<NodeStatus, string> = {
  pending: "#5b6474",
  running: "#6d8cff",
  completed: "#5ad4a0",
  failed: "#ff6b6b",
  skipped: "#2f3745",
};

const EDGE_STROKE = "#2f3745";

export function NoActiveGraph() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <h2 className="text-[14px] font-semibold tracking-tight">No active graph</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          When Grok plans a run with the Graph Engineering skill it writes the graph to
          <span className="font-mono text-ink-faint"> .grokspace/graphs/current-graph.json</span> in
          the project, falling back to
          <span className="font-mono text-ink-faint"> ~/.grokspace/graphs/</span>. This panel draws
          that file.
        </p>
      </div>
    </div>
  );
}

function GraphCanvas({ graph, warnings }: { graph: GraphDocument; warnings: string[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const direction = useMemo(() => inferDirection(graph.nodes), [graph.nodes]);

  const nodes = useMemo<GraphFlowNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "graphNode" as const,
        position: node.position,
        data: { node, direction },
        selected: node.id === selectedId,
      })),
    [graph.nodes, direction, selectedId],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        animated: edge.animated,
        ...(edge.label !== undefined ? { label: edge.label } : {}),
        style: { stroke: EDGE_STROKE },
        labelStyle: { fill: "#8c95a6", fontSize: 10 },
        labelBgStyle: { fill: "#101319" },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      })),
    [graph.edges],
  );

  // Derived rather than stored, so a node that disappears from a reloaded graph
  // closes the inspector on its own.
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;

  const onNodeClick: NodeMouseHandler = (_event, node) => setSelectedId(node.id);

  const notes = graph.state?.notes;
  const footer = [...(notes !== undefined ? [notes] : []), ...warnings];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          {/* Absolute fill: React Flow needs a parent it can measure. */}
          <div className="absolute inset-0">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.6}
              // This visualises a graph rather than editing one.
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              onNodeClick={onNodeClick}
              onPaneClick={() => setSelectedId(null)}
              attributionPosition="top-right"
              className="bg-canvas"
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222835" />
              <Controls showInteractive={false} />
              <MiniMap<GraphFlowNode>
                pannable
                zoomable
                nodeColor={(node) => MINIMAP_COLOR[node.data.node.status]}
                maskColor="#0b0d1299"
                className="rounded-md border border-line bg-panel!"
              />
            </ReactFlow>
          </div>
        </div>

        {footer.length > 0 && (
          <div className="shrink-0 border-t border-line bg-panel px-3 py-1.5">
            {footer.map((line) => (
              <p key={line} className="truncate text-[11px] text-ink-faint" title={line}>
                {line}
              </p>
            ))}
          </div>
        )}
      </div>

      {selected && <NodeInspector node={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

export default function GraphVisualizer({
  graph,
  warnings = [],
  error = null,
}: {
  graph: GraphDocument | null;
  warnings?: string[];
  error?: string | null;
}) {
  if (error !== null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <h2 className="text-[14px] font-semibold tracking-tight text-danger">
            That graph file could not be read
          </h2>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-muted selectable">{error}</p>
        </div>
      </div>
    );
  }

  if (!graph) return <NoActiveGraph />;

  return <GraphCanvas graph={graph} warnings={warnings} />;
}
