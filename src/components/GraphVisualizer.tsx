import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";

import { errorMessage } from "../lib/api";
import {
  graphTitleStampFor,
  inferDirection,
  ingestLockedGraph,
  lockGraphTitles,
  unlockGraphTitles,
  type GraphDocument,
  type GraphNode,
  type GraphTitleStamp,
} from "../lib/graph";
import { prefersReducedMotion } from "../lib/motion";
import { askForGraph, canAskForGraph } from "../lib/graphAsk";
import { openArtifactInDiff } from "../lib/graphArtifact";
import { homeRelative } from "../lib/paths";
import { graphNodeA11yLabel, nodeStatusLabel } from "../lib/statusText";
import { graphFor, useGraphStore } from "../stores/graphStore";
import { useSessionStore } from "../stores/sessionStore";
import { stepsFor, useStepStore } from "../stores/stepStore";
import type { Session } from "../types";
import GraphNodeCard, {
  NODE_HEIGHT,
  NODE_WIDTH,
  type GraphFlowNode,
} from "./graph/GraphNode";
import { graphTheme } from "../lib/theme";
import NodeInspector from "./graph/NodeInspector";
import { SkillInstallButton, useSkill } from "./SkillHint";
import { TextButton } from "./ui";

/** Module scope on purpose: React Flow warns when this object's identity changes. */
const nodeTypes = { graphNode: GraphNodeCard };

/**
 * The canvas takes colour as props rather than classes, so it reads the tokens out of
 * the stylesheet. A second copy of the palette here is exactly what made theme
 * switching a bigger job than styles.css claimed it would be.
 *
 * Read once per render rather than at module load: a module body runs before the
 * stylesheet is applied, and `getComputedStyle` would see nothing.
 */

/**
 * Typed into the agent's terminal by "Ask for a graph". Naming the variable
 * rather than a path keeps this correct for whichever session receives it.
 * The prompt itself lives in `lib/graphAsk.ts` so the ACP path can share it.
 */

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="max-w-sm text-center">{children}</div>
    </div>
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
  const skill = useSkill("graph").status;
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    setAsked(false);
  }, [session.id]);

  const canAsk = canAskForGraph(session);

  const ask = () => {
    setAsked(true);
    void askForGraph(session).catch((error) => {
      setAsked(false);
      useSessionStore.getState().setError(errorMessage(error));
    });
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
        <SkillInstallButton
          id="graph"
          variant="text"
          installLabel="Install the graph skill"
          updateLabel="Update the graph skill"
        />
      </div>

      {skill?.current === true && (
        <p className="mt-3 text-[10px] text-ink-faint">
          The graph skill is installed, so agents started from now on report their plans
          on their own.
        </p>
      )}
      {skill !== null && !skill.installed && (
        <p className="mt-3 text-[10px] leading-relaxed text-ink-faint">
          Installing writes the skill into{" "}
          <span className="font-mono selectable">{homeRelative(skill.path)}</span>, which
          is where Grok looks for them. It is a runbook plus two references: the topology
          catalogue and the graph file's contract, both read only when needed.
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

/**
 * Keyboard path into the inspector (A11Y-005). The canvas is pointer-first;
 * this list (or the compact <select>) is what Tab can actually operate.
 */
function GraphNodePicker({
  nodes,
  selectedId,
  onSelect,
  compact,
}: {
  nodes: GraphNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  compact: boolean;
}) {
  const selectId = useId();

  if (compact) {
    return (
      <div className="shrink-0 border-b border-line bg-panel px-2 py-1">
        <label htmlFor={selectId} className="sr-only">
          Graph nodes
        </label>
        <select
          id={selectId}
          value={selectedId ?? ""}
          onChange={(event) => onSelect(event.target.value === "" ? null : event.target.value)}
          className="w-full bg-transparent text-[11px] text-ink"
        >
          <option value="">Select a node</option>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {graphNodeA11yLabel(node)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <nav
      aria-label="Graph nodes"
      className="flex w-44 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel"
    >
      <p className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">
        Nodes
      </p>
      {nodes.length === 0 ? (
        <p className="px-2 text-[11px] text-ink-faint">No nodes</p>
      ) : (
        <ul className="flex flex-col px-1 pb-1">
          {nodes.map((node) => {
            const selected = node.id === selectedId;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  aria-label={graphNodeA11yLabel(node)}
                  onClick={() => onSelect(selected ? null : node.id)}
                  className={`flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-[11px] ${
                    selected
                      ? "bg-accent-soft text-ink"
                      : "text-ink-muted hover:bg-elevated hover:text-ink"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{node.label}</span>
                  <span className="shrink-0 font-mono text-[9px] text-ink-muted">
                    {nodeStatusLabel(node.status)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

function GraphCanvas({
  graph,
  warnings,
  compact,
  session,
  revisedTitles,
  onReopenSpec,
}: {
  graph: GraphDocument;
  warnings: string[];
  compact: boolean;
  session: Session;
  revisedTitles: boolean;
  onReopenSpec: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Tokens are fixed for the process; a fresh object every render would rebuild
  // edges and send React Flow into an update loop.
  const theme = useMemo(() => graphTheme(), []);

  // React Flow's StoreUpdater tracks `fitViewOptions` by reference. An inline
  // object every render re-queues fitView and can blow the update depth.
  const fitViewOptions = useMemo(
    () => ({ padding: 0.12, minZoom: compact ? 0.4 : 0.62, maxZoom: 1 }),
    [compact],
  );

  const direction = useMemo(() => inferDirection(graph.nodes), [graph.nodes]);
  const reduceMotion = prefersReducedMotion();

  // Selection stays out of this memo: putting `selectedId` here rebuilt every
  // React Flow node on a click. The inspector still uses `selectedId`; the ring
  // is React Flow's own selection.
  const nodes = useMemo<GraphFlowNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "graphNode" as const,
        position: node.position,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        data: { node, direction },
        ariaLabel: graphNodeA11yLabel(node),
      })),
    [graph.nodes, direction],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        animated: edge.animated && !reduceMotion,
        ...(edge.label !== undefined ? { label: edge.label } : {}),
        style: { stroke: theme.edge },
        labelStyle: { fill: theme.edgeLabel, fontSize: 10 },
        labelBgStyle: { fill: theme.edgeLabelBackground },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      })),
    [graph.edges, theme, reduceMotion],
  );

  // Derived rather than stored, so a node that disappears from a reloaded graph
  // closes the inspector on its own.
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;

  const onNodeClick = useCallback<NodeMouseHandler>((_event, node) => {
    setSelectedId(node.id);
  }, []);

  const onPaneClick = useCallback(() => setSelectedId(null), []);

  const notes = graph.state?.notes;
  const footer = [...(notes !== undefined ? [notes] : []), ...warnings];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {revisedTitles && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-1.5"
        >
          <p className="min-w-0 flex-1 text-[11px] leading-snug text-ink-muted">
            Graph titles changed after Build. Reopen Spec to revise the plan.
          </p>
          <TextButton label="Reopen Spec" onClick={onReopenSpec} />
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
      {!compact && (
        <GraphNodePicker
          nodes={graph.nodes}
          selectedId={selectedId}
          onSelect={setSelectedId}
          compact={false}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {compact && (
          <GraphNodePicker
            nodes={graph.nodes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            compact
          />
        )}
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
              fitViewOptions={fitViewOptions}
              minZoom={0.2}
              maxZoom={1.6}
              // This visualises a graph rather than editing one.
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              // Bottom-left holds the controls and bottom-right the minimap.
              attributionPosition="bottom-center"
              className="bg-canvas"
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color={theme.canvasDots} />
              <Controls showInteractive={false} />
              {/* A pane-sized canvas has no room for a minimap next to the graph. */}
              {!compact && (
                <MiniMap<GraphFlowNode>
                  pannable
                  zoomable
                  nodeColor={(node) => theme.node[node.data.node.status]}
                  nodeStrokeColor={theme.minimapStroke}
                  nodeStrokeWidth={2}
                  nodeBorderRadius={3}
                  bgColor={theme.minimapBackground}
                  maskColor={theme.minimapMask}
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
            <NodeInspector
              node={selected}
              onClose={() => setSelectedId(null)}
              onOpenArtifact={(path) =>
                void openArtifactInDiff(session.projectId, session.id, path)
              }
              compact
            />
          </div>
        ) : (
          <NodeInspector
            node={selected}
            onClose={() => setSelectedId(null)}
            onOpenArtifact={(path) =>
              void openArtifactInDiff(session.projectId, session.id, path)
            }
          />
        ))}
      </div>
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
  const stepsEntry = useStepStore((state) => stepsFor(state.bySession, sessionId));
  const [stamp, setStamp] = useState<GraphTitleStamp | undefined>();

  useEffect(() => {
    // The first read, for a pane mounted before WorkspaceShell had read every
    // session's graph. When that has happened the store is already current and
    // the watcher keeps it that way, so re-reading here would be a second read of
    // the same file on every switch into this view.
    if (sessionId !== undefined && !(sessionId in useGraphStore.getState().bySession)) {
      void load(sessionId);
    }
  }, [sessionId, load]);

  useEffect(() => {
    if (sessionId === undefined) return;
    // Steps may not be loaded on the Graph tab yet. Build can still have
    // stamped; do not unlock on the empty placeholder.
    if (stepsEntry.isLoading) {
      const existing = graphTitleStampFor(sessionId);
      if (existing !== undefined) setStamp(existing);
      return;
    }
    if (stepsEntry.phase === "approved") {
      const next = lockGraphTitles(sessionId, entry.graph);
      if (next !== undefined) setStamp(next);
      return;
    }
    unlockGraphTitles(sessionId);
    setStamp(undefined);
  }, [sessionId, stepsEntry.isLoading, stepsEntry.phase, entry.graph]);

  const locked = useMemo(() => {
    if (entry.graph === null || stamp === undefined) {
      return { graph: entry.graph, revisedTitles: false };
    }
    return ingestLockedGraph(entry.graph, stamp);
  }, [entry.graph, stamp]);

  const reopenSpec = useCallback(() => {
    if (sessionId === undefined) return;
    void useStepStore
      .getState()
      .reopen(sessionId)
      .then(() => {
        unlockGraphTitles(sessionId);
        setStamp(undefined);
      });
  }, [sessionId]);

  if (!session) return <NoSession />;
  if (entry.error !== null) return <UnreadableGraph error={entry.error} path={entry.path} />;
  if (locked.graph === null) {
    // Saying "no graph" before the first read has finished would be a guess.
    if (entry.isLoading) {
      return (
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          role="status"
          aria-busy="true"
          aria-live="polite"
        >
          <p className="text-[12px] text-ink-muted">Reading graph…</p>
        </div>
      );
    }
    return <AwaitingGraph session={session} path={entry.path} />;
  }

  return (
    <GraphCanvas
      graph={locked.graph}
      warnings={entry.warnings}
      compact={compact}
      session={session}
      revisedTitles={locked.revisedTitles}
      onReopenSpec={reopenSpec}
    />
  );
}

export { GraphVisualizer };
