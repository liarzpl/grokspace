import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { statusTally, type GraphNode, type GraphStatus } from "../lib/graph";
import { homeRelative } from "../lib/paths";
import { orphanedPermissions } from "../lib/permissions";
import { graphFor, useGraphStore } from "../stores/graphStore";
import { useMemoryStore } from "../stores/memoryStore";
import { TABS, useUiStore } from "../stores/uiStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTaskStore } from "../stores/taskStore";
import type { Project, Session, TaskStatus } from "../types";
import DiffPanel from "./DiffPanel";
import GraphVisualizer from "./GraphVisualizer";
import MemoryPanel from "./MemoryPanel";
import PaneGrid, { LayoutPicker } from "./PaneGrid";
import TaskBoard from "./TaskBoard";

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
 *
 * Agents have no pane, so Stop and Close live here (and in the palette) rather
 * than only on a terminal header that will never exist for them.
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
  const stopSession = useSessionStore((state) => state.stopSession);
  const closeSession = useSessionStore((state) => state.closeSession);
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
    <div
      className={`flex shrink-0 items-center gap-0.5 rounded-md border px-1 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-accent bg-accent-soft text-ink"
          : "border-line text-ink-faint hover:border-line-strong hover:text-ink-muted"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        title={entry.graph?.name ?? "No graph yet"}
        className="flex items-center gap-1.5 px-1"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${tone}`} />
        <span className="max-w-40 truncate">{sessionLabel(session)}</span>
        {session.kind === "agent" && (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">{session.status}</span>
        )}
      </button>
      {session.kind === "agent" && (
        <>
          {session.status !== "stopped" && (
            <ChipButton label="Stop" onClick={() => void stopSession(session.id)} />
          )}
          <ChipButton label="Close" onClick={() => void closeSession(session.id)} />
        </>
      )}
    </div>
  );
}

function ChipButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm px-1 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted"
    >
      {label}
    </button>
  );
}

/**
 * Allow/Deny for agents that no task card owns. Swarm launches and palette-started
 * agents would otherwise sit on `needs_input` with no way to answer.
 */
function OrphanedPermissionBanner() {
  const permissions = useSessionStore((state) => state.permissions);
  const sessions = useSessionStore((state) => state.sessions);
  const tasks = useTaskStore((state) => state.tasks);
  const answerPermission = useSessionStore((state) => state.answerPermission);
  const orphaned = orphanedPermissions(permissions, tasks);
  if (orphaned.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-elevated px-4 py-2">
      {orphaned.flatMap(({ sessionId, requests }) => {
        const title =
          sessions.find((session) => session.id === sessionId)?.title ?? "Agent";
        return requests.map((request) => (
          <div key={`${sessionId}-${request.requestId}`} className="flex items-start gap-3">
            <p className="min-w-0 flex-1 text-[11px] leading-snug text-ink-muted">
              <span className="text-ink">{title}</span>
              {" · "}
              {request.summary}
            </p>
            <div className="flex shrink-0 items-center gap-0.5">
              <ChipButton
                label="Allow"
                onClick={() => void answerPermission(sessionId, request.requestId, true)}
              />
              <ChipButton
                label="Deny"
                onClick={() => void answerPermission(sessionId, request.requestId, false)}
              />
            </div>
          </div>
        ));
      })}
    </div>
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
      {(sessions.length > 1 || sessions.some((session) => session.kind === "agent")) && (
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

/**
 * What the board adds up to, for the window header. Only the columns with
 * something in them are named, so an empty board says nothing rather than four
 * zeroes.
 */
function TaskSummary() {
  const tasks = useTaskStore((state) => state.tasks);
  if (tasks.length === 0) return null;

  const count = (status: TaskStatus) => tasks.filter((task) => task.status === status).length;
  const counted = (
    [
      [count("in_progress"), "in progress"],
      [count("review"), "in review"],
      [count("backlog"), "in the backlog"],
      [count("done"), "done"],
    ] as const
  )
    .filter(([total]) => total > 0)
    .map(([total, label]) => `${total} ${label}`)
    .join(" · ");

  return <span className="shrink-0 text-[10px] text-ink-faint">{counted}</span>;
}

/** How much the project remembers, for the window header. */
function MemorySummary() {
  const entries = useMemoryStore((state) => state.entries);
  if (entries.length === 0) return null;

  return (
    <span className="shrink-0 text-[10px] text-ink-faint">
      {entries.length} {entries.length === 1 ? "entry" : "entries"} every session reads
    </span>
  );
}

/** The selected graph's name, status, and node tally, for the window header. */
function GraphSummary({ session }: { session: Session | undefined }) {
  const entry = useGraphStore((state) => graphFor(state.bySession, session?.id));
  if (entry.graph === null) return null;

  return (
    <div className="flex shrink-0 items-baseline gap-2">
      <span className="text-[12px] font-medium text-ink-muted">{entry.graph.name}</span>
      <span
        className={`font-mono text-[10px] tracking-wide ${GRAPH_STATUS_TONE[entry.graph.status]}`}
      >
        {entry.graph.status}
      </span>
      <span className="text-[10px] text-ink-faint">{tallySummary(entry.graph.nodes)}</span>
    </div>
  );
}

export default function WorkspaceShell({ project }: { project: Project }) {
  const loadSessions = useSessionStore((state) => state.loadSessions);
  const sessions = useSessionStore((state) => state.sessions);
  const loadGraph = useGraphStore((state) => state.load);
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const loadMemory = useMemoryStore((state) => state.loadMemory);
  // In a store rather than local state: the command palette switches tabs too, and
  // two components cannot share a useState.
  const tab = useUiStore((state) => state.tab);
  const setTab = useUiStore((state) => state.setTab);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);

  useEffect(() => {
    void loadSessions(project.id);
  }, [project.id, loadSessions]);

  // Loaded with the project rather than when the tab opens: the header's tally is
  // how a task waiting in another column gets noticed at all.
  useEffect(() => {
    void loadTasks(project.id);
  }, [project.id, loadTasks]);

  useEffect(() => {
    void loadMemory(project.id);
  }, [project.id, loadMemory]);

  // Read every session's graph up front, not just the one on screen: the chips
  // here and the dot on each pane's switch are how a plan waiting in another
  // terminal gets noticed at all. Joined into a string so this depends on which
  // sessions exist rather than on the array, which a status change replaces.
  const sessionIds = sessions.map((session) => session.id).join(" ");
  useEffect(() => {
    for (const id of sessionIds.split(" ").filter(Boolean)) void loadGraph(id);
  }, [sessionIds, loadGraph]);

  useEffect(() => {
    // Watching is what makes the graphs live: the backend reports each file as it
    // changes and the graph store re-reads it. There is nothing to undo here — the
    // backend keeps one watch per project until it quits, precisely so that a
    // remount cannot leave a project unwatched.
    void api.watchProjectGraphs(project.id).catch(() => {});
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

        {tab === "terminals" && <LayoutPicker project={project} />}
        {tab === "graph" && <GraphSummary session={graphSession} />}
        {tab === "tasks" && <TaskSummary />}
        {tab === "memory" && <MemorySummary />}
      </header>

      <OrphanedPermissionBanner />

      {/*
        Switching away unmounts the grid, which is safe: lib/terminals.ts holds
        each xterm instance and its detached container outside React, so the ptys
        keep running and the scrollback survives the remount.
      */}
      {tab === "terminals" && <PaneGrid project={project} />}
      {tab === "graph" && (
        <GraphTab sessions={sessions} selected={graphSession} onSelect={setSelectedGraphId} />
      )}
      {tab === "tasks" && <TaskBoard project={project} />}
      {tab === "memory" && <MemoryPanel project={project} />}
      {tab === "diff" && <DiffPanel project={project} />}
    </div>
  );
}
