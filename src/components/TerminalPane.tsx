import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import {
  attachTerminal,
  clearTerminal,
  detachTerminal,
  fitTerminal,
  focusTerminal,
  mountTerminal,
  writeNotice,
} from "../lib/terminals";
import { graphFor, useGraphStore } from "../stores/graphStore";
import { stepsFor, useStepStore } from "../stores/stepStore";
import { useSessionStore } from "../stores/sessionStore";
import type { Session, SessionKind } from "../types";
import GraphVisualizer from "./GraphVisualizer";
import SessionSteps from "./SessionSteps";

/** A pane is created before it has been measured, so it starts at the classic size. */
const FALLBACK_SIZE = { cols: 80, rows: 24 };

/** Long enough to swallow the burst a window drag produces, short enough to feel live. */
const RESIZE_DEBOUNCE_MS = 80;

function StatusDot({ session }: { session: Session }) {
  const running = session.status === "running";
  return (
    <span
      title={running ? "Running" : "Stopped"}
      className={`size-1.5 shrink-0 rounded-full ${running ? "bg-green-400" : "bg-ink-faint"}`}
    />
  );
}

function PaneButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-sm px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-line-strong hover:text-ink disabled:opacity-40"
    >
      {label}
    </button>
  );
}

/**
 * Flips a pane between its terminal and the graph its session is reporting, so a
 * plan can be watched in one pane while the others keep working. The terminal is
 * not stopped by this: lib/terminals.ts keeps the instance and its pty alive while
 * the graph has the pane.
 */
function ViewSwitch({ session, paneId }: { session: Session; paneId: string }) {
  const view = useSessionStore((state) => state.paneViews[paneId] ?? "terminal");
  const setPaneView = useSessionStore((state) => state.setPaneView);
  const hasGraph = useGraphStore(
    (state) => graphFor(state.bySession, session.id).graph !== null,
  );
  const hasSteps = useStepStore(
    (state) => stepsFor(state.bySession, session.id).steps.length > 0,
  );

  const options =
    session.kind === "shell"
      ? (["terminal", "graph"] as const)
      : (["terminal", "graph", "tasks"] as const);

  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-sm border border-line px-0.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setPaneView(paneId, option)}
          title={
            option === "graph" && !hasGraph
              ? "This session has not reported a graph yet"
              : option === "tasks" && !hasSteps
                ? "This session has not proposed steps yet"
                : undefined
          }
          className={`rounded-sm px-1 text-[10px] transition-colors ${
            view === option ? "bg-accent-soft text-ink" : "text-ink-faint hover:text-ink-muted"
          }`}
        >
          {option === "terminal" ? "term" : option === "graph" ? "graph" : "tasks"}
          {option === "graph" && hasGraph && (
            <span className="ml-1 inline-block size-1 rounded-full bg-accent align-middle" />
          )}
          {option === "tasks" && hasSteps && (
            <span className="ml-1 inline-block size-1 rounded-full bg-accent align-middle" />
          )}
        </button>
      ))}
    </div>
  );
}

function EmptyPane({ paneId, projectId }: { paneId: string; projectId: string }) {
  const startSession = useSessionStore((state) => state.startSession);
  const busy = useSessionStore((state) => state.busyPanes[paneId] ?? false);

  const start = (kind: SessionKind) =>
    void startSession({ projectId, paneId, kind, ...FALLBACK_SIZE });

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5">
      <p className="text-[11px] text-ink-faint">Empty pane</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => start("grok")}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Starting…" : "Start Grok"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => start("shell")}
          className="rounded-md border border-line-strong px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-50"
        >
          Shell
        </button>
      </div>
    </div>
  );
}

/**
 * Hosts the session's xterm instance. The terminal itself lives in the registry
 * in lib/terminals.ts, so remounting this component neither loses scrollback nor
 * registers a second input handler.
 */
function TerminalSurface({ session }: { session: Session }) {
  const host = useRef<HTMLDivElement>(null);
  const lastStatus = useRef(session.status);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    mountTerminal(session.id, element);

    const sync = () => {
      const size = fitTerminal(session.id);
      // A stopped session has no pty to resize; the pane already says so.
      if (size) void api.resizeSession(session.id, size.cols, size.rows).catch(() => {});
    };

    sync();
    // A reconciled session from a previous run has no pty behind it, so this
    // rejects and the pane simply stays empty until it is restarted.
    void attachTerminal(session.id).catch(() => {});

    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(sync, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      // Leave the instance in the registry so scrollback survives; just take it
      // out of this host so the next project (same pane id) does not inherit it.
      detachTerminal(session.id);
    };
  }, [session.id]);

  useEffect(() => {
    if (lastStatus.current === "running" && session.status === "stopped") {
      writeNotice(
        session.id,
        session.exitCode == null
          ? "Session ended."
          : `Session ended with exit code ${session.exitCode}.`,
      );
    }
    lastStatus.current = session.status;
  }, [session.id, session.status, session.exitCode]);

  return (
    <div
      ref={host}
      onMouseDown={() => focusTerminal(session.id)}
      className="min-h-0 flex-1 overflow-hidden px-2 pb-1"
    />
  );
}

export default function TerminalPane({
  paneId,
  projectId,
  session,
}: {
  paneId: string;
  projectId: string;
  session?: Session;
}) {
  const [renaming, setRenaming] = useState(false);
  const maximizedPane = useSessionStore((state) => state.maximizedPane);
  const paneView = useSessionStore((state) => state.paneViews[paneId] ?? "terminal");
  const toggleMaximized = useSessionStore((state) => state.toggleMaximized);
  const stopSession = useSessionStore((state) => state.stopSession);
  const restartSession = useSessionStore((state) => state.restartSession);
  const renameSession = useSessionStore((state) => state.renameSession);
  const closeSession = useSessionStore((state) => state.closeSession);
  const busy = useSessionStore((state) => state.busyPanes[paneId] ?? false);

  const isMaximized = maximizedPane === paneId;
  const running = session?.status === "running";
  const view =
    paneView === "tasks" && session?.kind === "shell" ? "terminal" : paneView;

  const restart = () => {
    if (!session) return;
    const size = fitTerminal(session.id) ?? FALLBACK_SIZE;
    void restartSession(session.id, size.cols, size.rows);
  };

  const commitRename = (value: string) => {
    setRenaming(false);
    const title = value.trim();
    if (session && title && title !== session.title) void renameSession(session.id, title);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-terminal">
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        {session ? <StatusDot session={session} /> : null}

        {renaming && session ? (
          <input
            autoFocus
            defaultValue={session.title ?? ""}
            onBlur={(event) => commitRename(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setRenaming(false);
            }}
            className="min-w-0 flex-1 rounded-sm border border-accent bg-canvas px-1 text-[11px] text-ink outline-none selectable"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => session && setRenaming(true)}
            title={session ? "Double-click to rename" : undefined}
            className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-ink-muted"
          >
            {session?.title ?? `Pane ${Number(paneId) + 1}`}
            {/* Only when it says something the title does not. A session started as a
                role is titled after it, so printing both would read "Reviewer · Reviewer". */}
            {session?.role != null && session.role !== session.title ? (
              <span className="ml-1.5 text-ink-faint">· {session.role}</span>
            ) : null}
            {session && !running ? (
              <span className="ml-1.5 text-ink-faint">
                {session.exitCode == null ? "· stopped" : `· exit ${session.exitCode}`}
              </span>
            ) : null}
          </button>
        )}

        <div className="flex shrink-0 items-center gap-1">
          {session ? <ViewSwitch session={session} paneId={paneId} /> : null}
          <div className="flex items-center">
            {session ? (
              <>
                {view === "terminal" && (
                  <PaneButton label="Clear" onClick={() => clearTerminal(session.id)} />
                )}
                {running ? (
                  <PaneButton label="Stop" onClick={() => void stopSession(session.id)} />
                ) : (
                  <PaneButton label="Restart" onClick={restart} disabled={busy} />
                )}
                <PaneButton label="Close" onClick={() => void closeSession(session.id)} />
              </>
            ) : null}
            <PaneButton
              label={isMaximized ? "Restore" : "Expand"}
              onClick={() => toggleMaximized(paneId)}
            />
          </div>
        </div>
      </header>

      {session ? (
        view === "graph" ? (
          <GraphVisualizer session={session} compact />
        ) : view === "tasks" ? (
          <SessionSteps session={session} compact />
        ) : (
          <TerminalSurface session={session} />
        )
      ) : (
        <EmptyPane paneId={paneId} projectId={projectId} />
      )}
    </section>
  );
}
