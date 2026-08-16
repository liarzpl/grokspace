import { useEffect, useMemo, useState } from "react";

import { parseGraph, statusTally, type GraphNode, type GraphStatus } from "../lib/graph";
import { SAMPLE_GRAPH } from "../lib/graphFixture";
import { homeRelative } from "../lib/paths";
import { useSessionStore } from "../stores/sessionStore";
import type { Project } from "../types";
import GraphVisualizer from "./GraphVisualizer";
import PaneGrid, { LayoutPicker } from "./PaneGrid";

type WorkspaceTab = "terminals" | "graph";

const TABS: readonly { id: WorkspaceTab; label: string }[] = [
  { id: "terminals", label: "Terminals" },
  { id: "graph", label: "Graph" },
];

const GRAPH_STATUS_TONE: Record<GraphStatus, string> = {
  pending: "text-ink-faint",
  running: "text-accent",
  completed: "text-success",
  failed: "text-danger",
  // `partial` exists at the graph level only: some branches landed, some did not.
  partial: "text-warning",
};

function tallySummary(nodes: GraphNode[]): string {
  const tally = statusTally(nodes);
  return (
    [
      [tally.running, "running"],
      [tally.completed, "done"],
      [tally.failed, "failed"],
      [tally.skipped, "skipped"],
      [tally.pending, "pending"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(" · ");
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-sm px-2 py-0.5 text-[11px] transition-colors ${
        active ? "bg-accent-soft text-ink" : "text-ink-faint hover:bg-elevated hover:text-ink-muted"
      }`}
    >
      {label}
    </button>
  );
}

export default function WorkspaceShell({ project }: { project: Project }) {
  const loadSessions = useSessionStore((state) => state.loadSessions);
  const [tab, setTab] = useState<WorkspaceTab>("terminals");

  useEffect(() => {
    void loadSessions(project.id);
  }, [project.id, loadSessions]);

  // Phase 1 reads a fixture. The file watcher will replace this source without
  // the visualiser itself changing, since it only takes a parsed document.
  const parsed = useMemo(() => parseGraph(SAMPLE_GRAPH), []);
  const graph = parsed.ok ? parsed.graph : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <h1 className="shrink-0 text-[14px] font-semibold tracking-tight">{project.name}</h1>
        <span
          title={project.path}
          className="min-w-0 truncate font-mono text-[11px] text-ink-faint"
        >
          {homeRelative(project.path)}
        </span>

        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-line p-0.5">
          {TABS.map(({ id, label }) => (
            <TabButton key={id} label={label} active={tab === id} onClick={() => setTab(id)} />
          ))}
        </div>

        <div className="flex-1" />

        {tab === "terminals" ? (
          <LayoutPicker project={project} />
        ) : (
          graph && (
            <div className="flex shrink-0 items-baseline gap-2">
              <span className="text-[12px] font-medium text-ink-muted">{graph.name}</span>
              <span
                className={`font-mono text-[10px] tracking-wide ${GRAPH_STATUS_TONE[graph.status]}`}
              >
                {graph.status}
              </span>
              <span className="text-[10px] text-ink-faint">{tallySummary(graph.nodes)}</span>
            </div>
          )
        )}
      </header>

      {/*
        Switching away unmounts the grid, which is safe: lib/terminals.ts holds
        each xterm instance and its detached container outside React, so the ptys
        keep running and the scrollback survives the remount.
      */}
      {tab === "terminals" ? (
        <PaneGrid project={project} />
      ) : (
        <GraphVisualizer
          graph={graph}
          warnings={parsed.ok ? parsed.warnings : []}
          error={parsed.ok ? null : parsed.error}
        />
      )}
    </div>
  );
}
