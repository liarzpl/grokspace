import { useEffect, useMemo, useState } from "react";
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

import { api } from "../lib/api";
import { inferDirection, type GraphDocument, type NodeStatus } from "../lib/graph";
import { homeRelative } from "../lib/paths";
import { graphFor, useGraphStore } from "../stores/graphStore";
import type { Session } from "../types";
import GraphNodeCard, {
  NODE_HEIGHT,
  NODE_WIDTH,
  type GraphFlowNode,
} from "./graph/GraphNode";
import NodeInspector from "./graph/NodeInspector";

/** Module scope on purpose: React Flow warns when this object's identity changes. */
const nodeTypes = { graphNode: GraphNodeCard };

const MINIMAP_COLOR: Record<NodeStatus, string> = {
  pending: "#5b6474",
  running: "#6d8cff",
  completed: "#5ad4a0",
  failed: "#ff6b6b",
  skipped: "#333b49",
};

const EDGE_STROKE = "#2f3745";

/**
 * Typed into the agent's terminal by "Ask for a graph". Naming the variable
 * rather than a path keeps this correct for whichever session receives it.
 */
const GRAPH_REQUEST =
  "Write your plan for this work as a graph to $GROKSPACE_GRAPH_FILE now, " +
  "then keep the node statuses in that file up to date as you go.";

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="max-w-sm text-center">{children}</div>
    </div>
  );
}

function TextButton({
  label,
  onClick,
  disabled,
  primary,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        primary
          ? "rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
          : "rounded-md border border-line-strong px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-50"
      }
    >
      {label}
    </button>
  );
}

function NoSession() {
  return (
    <Centred>
      <h2 className="text-[14px] font-semibold tracking-tight">Nothing to draw yet</h2>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
        Start a Grok agent and its graph appears here, drawn from the file that agent
        writes as it plans and works. Every session gets its own.
      </p>
    </Centred>
  );
}

/**
 * Shown until a session's file exists. It has work to do: name the exact file this
 * pane watches, and offer the two things that make a graph appear — the skill that
 * teaches `grok` to write one, and a direct request to this agent.
 */
function AwaitingGraph({ session, path }: { session: Session; path: string }) {
  const skill = useGraphStore((state) => state.skill);
  const isInstalling = useGraphStore((state) => state.isInstallingSkill);
  const loadSkill = useGraphStore((state) => state.loadSkill);
  const installSkill = useGraphStore((state) => state.installSkill);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    void loadSkill();
  }, [loadSkill]);

  const canAsk = session.kind === "grok" && session.status === "running";

  const ask = () => {
    setAsked(true);
    void api.writeSession(session.id, `${GRAPH_REQUEST}\r`).catch(() => setAsked(false));
  };

  return (
    <Centred>
      <h2 className="text-[14px] font-semibold tracking-tight">No graph yet</h2>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
        Every session has a graph of its own. This one is drawn from the file{" "}
        <span className="text-ink">{session.title ?? "this session"}</span> writes, and it
        appears the moment that file does.
      </p>
      {path !== "" && (
        // Wrapped rather than truncated: the path is the thing someone reading this
        // is most likely to want in full.
        <p className="mt-2.5 font-mono text-[10px] break-all text-ink-faint selectable">
          {homeRelative(path)}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {canAsk && (
          <TextButton
            primary
            label={asked ? "Asked" : "Ask for a graph"}
            onClick={ask}
            disabled={asked}
          />
        )}
        {skill !== null && !skill.current && (
          <TextButton
            label={
              isInstalling
                ? "Installing…"
                : skill.installed
                  ? "Update the graph skill"
                  : "Install the graph skill"
            }
            onClick={() => void installSkill()}
            disabled={isInstalling}
          />
        )}
      </div>

      {skill?.current === true && (
        <p className="mt-3 text-[10px] text-ink-faint">
          The graph skill is installed, so agents started from now on report their plans
          on their own.
        </p>
      )}
      {skill !== null && !skill.installed && (
        <p className="mt-3 text-[10px] leading-relaxed text-ink-faint">
          Installing writes a skill to{" "}
          <span className="font-mono selectable">{homeRelative(skill.path)}</span>, which
          is where Grok looks for them.
        </p>
      )}
    </Centred>
  );
}

function UnreadableGraph({ error, path }: { error: string; path: string }) {
  return (
    <Centred>
      <h2 className="text-[14px] font-semibold tracking-tight text-danger">
        That graph file could not be read
      </h2>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-muted selectable">{error}</p>
      {path !== "" && (
        <p title={path} className="mt-2.5 truncate font-mono text-[10px] text-ink-faint">
          {homeRelative(path)}
        </p>
      )}
    </Centred>
  );
}

function GraphCanvas({
  graph,
  warnings,
  compact,
}: {
  graph: GraphDocument;
  warnings: string[];
  compact: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const direction = useMemo(() => inferDirection(graph.nodes), [graph.nodes]);

  const nodes = useMemo<GraphFlowNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "graphNode" as const,
        position: node.position,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
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
    <div className="relative flex min-h-0 flex-1">
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
              // A seven-layer graph fitted into a pane this narrow zooms out far
              // enough that the labels stop being readable, so fitting has a floor
              // and the rest is left to panning. A pane is narrower again, so its
              // floor is lower.
              fitViewOptions={{ padding: 0.12, minZoom: compact ? 0.4 : 0.62, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.6}
              // This visualises a graph rather than editing one.
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              onNodeClick={onNodeClick}
              onPaneClick={() => setSelectedId(null)}
              // Bottom-left holds the controls and bottom-right the minimap.
              attributionPosition="bottom-center"
              className="bg-canvas"
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222835" />
              <Controls showInteractive={false} />
              {/* A pane-sized canvas has no room for a minimap next to the graph. */}
              {!compact && (
                <MiniMap<GraphFlowNode>
                  pannable
                  zoomable
                  nodeColor={(node) => MINIMAP_COLOR[node.data.node.status]}
                  nodeStrokeColor="#0b0d12"
                  nodeStrokeWidth={2}
                  nodeBorderRadius={3}
                  bgColor="#0e1117"
                  maskColor="#0b0d12b3"
                  className="rounded-md border border-line"
                />
              )}
            </ReactFlow>
          </div>
        </div>

        {footer.length > 0 && (
          <div className="shrink-0 border-t border-line bg-panel px-3 py-1.5">
            {footer.slice(0, compact ? 1 : footer.length).map((line) => (
              <p key={line} className="truncate text-[11px] text-ink-faint" title={line}>
                {line}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* In a pane there is no width to give up, so the inspector floats over the
          canvas instead of taking a column from it. */}
      {selected &&
        (compact ? (
          <div className="absolute inset-y-0 right-0 z-10 flex w-56 shadow-xl shadow-black/40">
            <NodeInspector node={selected} onClose={() => setSelectedId(null)} compact />
          </div>
        ) : (
          <NodeInspector node={selected} onClose={() => setSelectedId(null)} />
        ))}
    </div>
  );
}

/**
 * Draws one session's graph. The session is the unit throughout: the store keys
 * graphs by session id and the backend keys files by it, so two panes never show
 * each other's plan.
 */
export default function GraphVisualizer({
  session,
  compact = false,
}: {
  session: Session | undefined;
  compact?: boolean;
}) {
  const sessionId = session?.id;
  const entry = useGraphStore((state) => graphFor(state.bySession, sessionId));
  const load = useGraphStore((state) => state.load);

  useEffect(() => {
    // The first read, for a pane mounted before WorkspaceShell had read every
    // session's graph. When that has happened the store is already current and
    // the watcher keeps it that way, so re-reading here would be a second read of
    // the same file on every switch into this view.
    if (sessionId !== undefined && !(sessionId in useGraphStore.getState().bySession)) {
      void load(sessionId);
    }
  }, [sessionId, load]);

  if (!session) return <NoSession />;
  if (entry.error !== null) return <UnreadableGraph error={entry.error} path={entry.path} />;
  if (entry.graph === null) {
    // Saying "no graph" before the first read has finished would be a guess.
    if (entry.isLoading) return <div className="min-h-0 flex-1" />;
    return <AwaitingGraph session={session} path={entry.path} />;
  }

  return <GraphCanvas graph={entry.graph} warnings={entry.warnings} compact={compact} />;
}
