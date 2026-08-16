import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { statusTally, type GraphNode, type GraphStatus } from "../lib/graph";
import { homeRelative } from "../lib/paths";
import { graphFor, useGraphStore } from "../stores/graphStore";
import { useSessionStore } from "../stores/sessionStore";
import type { Project, Session } from "../types";
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

/** Names a session the way its pane does, so the two views agree. */
function sessionLabel(session: Session): string {
  const pane = session.paneId === null ? "" : `${Number(session.paneId) + 1} · `;
  return `${pane}${session.title ?? "Session"}`;
}

/**
 * One chip per session. The dot reports the graph rather than the process: a
 * running agent that has not written a plan yet is exactly the case this panel
 * exists to make visible.
 */
function SessionChip({
  session,
  active,
  onClick,
}: {
  session: Session;
  active: boolean;
  onClick: () => void;
}) {
  const entry = useGraphStore((state) => graphFor(state.bySession, session.id));
  const status = entry.graph?.status;
  const tone =
    entry.error !== null
      ? "bg-danger"
      : status !== undefined
        ? {
            pending: "bg-ink-faint",
            running: "bg-accent",
            completed: "bg-success",
            failed: "bg-danger",
            partial: "bg-warning",
          }[status]
        : "bg-line-strong";

  return (
    <button
      type="button"
      onClick={onClick}
      title={entry.graph === null ? "No graph yet" : (entry.graph.name ?? undefined)}
      className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-accent bg-accent-soft text-ink"
          : "border-line text-ink-faint hover:border-line-strong hover:text-ink-muted"
      }`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${tone}`} />
      <span className="max-w-40 truncate">{sessionLabel(session)}</span>
    </button>
  );
}

/**
 * The graph view of the workspace: every session's graph is reachable from here,
 * and the one on screen is whichever session is selected.
 */
function GraphTab({
  sessions,
  selected,
  onSelect,
}: {
  sessions: Session[];
  selected: Session | undefined;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sessions.length > 1 && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-1.5">
          {sessions.map((session) => (
            <SessionChip
              key={session.id}
              session={session}
              active={session.id === selected?.id}
              onClick={() => onSelect(session.id)}
            />
          ))}
        </div>
      )}

      <GraphVisualizer session={selected} />
    </div>
  );
}

/** The selected graph's name, status, and node tally, for the window header. */
function GraphSummary({ session }: { session: Session | undefined }) {
  const entry = useGraphStore((state) => graphFor(state.bySession, session?.id));
  if (entry.graph === null) return null;

  return (
    <div className="flex shrink-0 items-baseline gap-2">
      <span className="text-[12px] font-medium text-ink-muted">{entry.graph.name}</span>
      <span className={`font-mono text-[10px] tracking-wide ${GRAPH_STATUS_TONE[entry.graph.status]}`}>
        {entry.graph.status}
      </span>
      <span className="text-[10px] text-ink-faint">{tallySummary(entry.graph.nodes)}</span>
    </div>
  );
}

export default function WorkspaceShell({ project }: { project: Project }) {
  const loadSessions = useSessionStore((state) => state.loadSessions);
  const sessions = useSessionStore((state) => state.sessions);
  const [tab, setTab] = useState<WorkspaceTab>("terminals");
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);

  useEffect(() => {
    void loadSessions(project.id);
  }, [project.id, loadSessions]);

  useEffect(() => {
    // Watching is what makes the graphs live: the backend reports each file as it
    // changes and the graph store re-reads it.
    void api.watchProjectGraphs(project.id).catch(() => {});
    return () => {
      void api.unwatchProjectGraphs(project.id).catch(() => {});
    };
  }, [project.id]);

  // Derived rather than stored, so closing the selected session hands the graph
  // view to another one instead of leaving an empty canvas behind.
  const graphSession =
    sessions.find((session) => session.id === selectedGraphId) ?? sessions[0] ?? undefined;

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
          <GraphSummary session={graphSession} />
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
        <GraphTab sessions={sessions} selected={graphSession} onSelect={setSelectedGraphId} />
      )}
    </div>
  );
}
