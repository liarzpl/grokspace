import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { isKeyboardClick } from "../lib/keyboardClick";
import { clientErrorMessage, isQuietHostError, logClientError } from "../lib/log";
import { moveSegmented } from "../lib/segmented";
import { FALLBACK_PTY_SIZE } from "../lib/limits";
import {
  attachTerminal,
  clearTerminal,
  detachTerminal,
  fitTerminal,
  focusTerminal,
  mountTerminal,
  writeNotice,
} from "../lib/terminals";
import { sessionStatusPhrase } from "../lib/statusText";
import { graphFor, useGraphStore } from "../stores/graphStore";
import { stepsFor, useStepStore } from "../stores/stepStore";
import {
  PERMISSION_MODES,
  permissionModeFor,
  useSessionStore,
  type PermissionMode,
} from "../stores/sessionStore";
import { useUiStore } from "../stores/uiStore";
import type { Session, SessionKind } from "../types";
import SessionSteps from "./SessionSteps";

const GraphVisualizer = lazy(() => import("./GraphVisualizer"));
import { QuietButton, StatusDot } from "./ui";

/** Long enough to swallow the burst a window drag produces, short enough to feel live. */
const RESIZE_DEBOUNCE_MS = 80;

/**
 * Flips a pane between its terminal, the graph its session is reporting, and
 * that session's steps. The workspace Tasks tab is the Kanban board; this face
 * is not. The terminal is not stopped by this: lib/terminals.ts keeps the
 * instance and its pty alive while another face has the pane.
 */
function ViewSwitch({ session, paneId }: { session: Session; paneId: string }) {
  const view = useUiStore((state) => state.paneViews[paneId] ?? "terminal");
  const setPaneView = useUiStore((state) => state.setPaneView);
  const hasGraph = useGraphStore(
    (state) => graphFor(state.bySession, session.id).graph !== null,
  );
  const hasSteps = useStepStore(
    (state) => stepsFor(state.bySession, session.id).steps.length > 0,
  );

  const options =
    session.kind === "shell"
      ? (["terminal", "graph"] as const)
      : (["terminal", "graph", "steps"] as const);

  return (
    <div
      role="radiogroup"
      aria-label="Pane view"
      onKeyDown={(event) =>
        moveSegmented(
          event,
          options,
          view,
          (option) => setPaneView(paneId, option),
          (option) => `pane-view-${paneId}-${option}`,
        )
      }
      className="flex shrink-0 items-center gap-0.5 rounded-sm border border-line px-0.5"
    >
      {options.map((option) => (
        <button
          key={option}
          id={`pane-view-${paneId}-${option}`}
          type="button"
          role="radio"
          aria-checked={view === option}
          tabIndex={view === option ? 0 : -1}
          onClick={() => setPaneView(paneId, option)}
          title={
            option === "graph" && !hasGraph
              ? "This session has not reported a graph yet"
              : option === "steps" && !hasSteps
                ? "This session has not proposed steps yet"
                : undefined
          }
          aria-label={
            option === "graph"
              ? hasGraph
                ? "graph, has graph"
                : "graph, no graph yet"
              : option === "steps"
                ? hasSteps
                  ? "steps, has steps"
                  : "steps, no steps yet"
                : "term"
          }
          className={`rounded-sm px-1 text-[10px] transition-colors ${
            view === option ? "bg-accent-soft text-ink" : "text-ink-faint hover:text-ink-muted"
          }`}
        >
          {option === "terminal" ? "term" : option === "graph" ? "graph" : "steps"}
          {option === "graph" && hasGraph && (
            <span aria-hidden="true" className="ml-1 inline-block size-1 rounded-full bg-accent align-middle" />
          )}
          {option === "steps" && hasSteps && (
            <span aria-hidden="true" className="ml-1 inline-block size-1 rounded-full bg-accent align-middle" />
          )}
        </button>
      ))}
    </div>
  );
}

const PERMISSION_MODE_TITLE: Record<PermissionMode, string> = {
  plan: "Spec — the steps list can still change. Not passed to grok.",
  ask: "Prompt each tool, same as today",
  acceptEdits: "Allow matching file edits this session as Allow once",
};

/**
 * Host-only plan | ask | acceptEdits. plan is Spec. acceptEdits uses the
 * session edit-class lease, still allow_once. No yolo chip.
 */
function PermissionModeChip({ session }: { session: Session }) {
  const stored = useSessionStore((state) => state.permissionModes[session.id]);
  const setPermissionMode = useSessionStore((state) => state.setPermissionMode);
  const phase = useStepStore(
    (state) => stepsFor(state.bySession, session.id).phase,
  );
  const mode = permissionModeFor(phase, stored);

  return (
    <div
      role="radiogroup"
      aria-label="Permission mode"
      onKeyDown={(event) =>
        moveSegmented(
          event,
          PERMISSION_MODES,
          mode,
          (option) => void setPermissionMode(session.id, option),
          (option) => `permission-mode-${session.id}-${option}`,
        )
      }
      className="flex shrink-0 items-center gap-0.5 rounded-sm border border-line px-0.5"
    >
      {PERMISSION_MODES.map((option) => (
        <button
          key={option}
          id={`permission-mode-${session.id}-${option}`}
          type="button"
          role="radio"
          aria-checked={mode === option}
          tabIndex={mode === option ? 0 : -1}
          title={PERMISSION_MODE_TITLE[option]}
          onClick={() => void setPermissionMode(session.id, option)}
          className={`rounded-sm px-1 text-[10px] transition-colors ${
            mode === option ? "bg-accent-soft text-ink" : "text-ink-faint hover:text-ink-muted"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function EmptyPane({ paneId, projectId }: { paneId: string; projectId: string }) {
  const startSession = useSessionStore((state) => state.startSession);
  const busy = useSessionStore((state) => state.busyPanes[paneId] ?? false);
  const isLoading = useSessionStore((state) => state.isLoading);
  const locked = busy || isLoading;

  const start = (kind: SessionKind) => {
    // `isLoading` means the pane is empty because the list is in flight, not
    // because this slot is free. Start here would race that snapshot.
    if (useSessionStore.getState().isLoading) return;
    void startSession({ projectId, paneId, kind, ...FALLBACK_PTY_SIZE });
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5">
      <p className="text-[11px] text-ink-faint">
        {isLoading ? "Loading sessions…" : "Empty pane"}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={locked}
          onClick={() => start("grok")}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Starting…" : "Start Grok"}
        </button>
        <button
          type="button"
          disabled={locked}
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
      if (size) {
        void api.resizeSession(session.id, size.cols, size.rows).catch((error) => {
          if (isQuietHostError(error)) return;
          logClientError("resize", `${session.id}: ${clientErrorMessage(error)}`);
        });
      }
    };

    sync();
    // A reconciled session from a previous run has no pty behind it, so this
    // rejects and the pane simply stays empty until it is restarted.
    void attachTerminal(session.id).catch((error) => {
      const message = clientErrorMessage(error);
      logClientError("attach", `${session.id}: ${message}`);
      const live = useSessionStore.getState().sessions.find((item) => item.id === session.id);
      if (live != null && live.status !== "stopped") {
        useSessionStore.setState({
          error: `Could not attach the terminal: ${message}`,
        });
      }
    });

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
      data-testid="terminal-surface"
      onMouseDown={() => focusTerminal(session.id)}
      className="min-h-0 flex-1 overflow-hidden px-2 pb-1"
    />
  );
}

function TerminalPane({
  paneId,
  projectId,
  session,
}: {
  paneId: string;
  projectId: string;
  session?: Session;
}) {
  const [renaming, setRenaming] = useState(false);
  const maximizedPane = useUiStore((state) => state.maximizedPane);
  const paneView = useUiStore((state) => state.paneViews[paneId] ?? "terminal");
  const toggleMaximized = useUiStore((state) => state.toggleMaximized);
  const stopSession = useSessionStore((state) => state.stopSession);
  const restartSession = useSessionStore((state) => state.restartSession);
  const renameSession = useSessionStore((state) => state.renameSession);
  const closeSession = useSessionStore((state) => state.closeSession);
  const busy = useSessionStore((state) => state.busyPanes[paneId] ?? false);

  const isMaximized = maximizedPane === paneId;
  const running = session?.status === "running";
  const view =
    paneView === "steps" && session?.kind === "shell" ? "terminal" : paneView;

  const restart = () => {
    if (!session) return;
    const size = fitTerminal(session.id) ?? FALLBACK_PTY_SIZE;
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
        {session ? (
          <StatusDot status={session.status} title={sessionStatusPhrase(session.status)} />
        ) : null}

        {renaming && session ? (
          <input
            autoFocus
            defaultValue={session.title ?? ""}
            aria-label={`Rename ${session.title ?? `pane ${Number(paneId) + 1}`}`}
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
            onClick={(event) => {
              if (session && isKeyboardClick(event)) setRenaming(true);
            }}
            onKeyDown={(event) => {
              if (session && event.key === "F2") {
                event.preventDefault();
                setRenaming(true);
              }
            }}
            aria-label={session ? `Rename ${session.title ?? `pane ${Number(paneId) + 1}`}` : undefined}
            title={session ? "Rename (Enter or F2). Double-click also works." : undefined}
            className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-ink-muted"
          >
            {session?.title ?? `Pane ${Number(paneId) + 1}`}
            {/* Only when it says something the title does not. A session started as a
                role is titled after it, so printing both would read "Reviewer · Reviewer". */}
            {session?.role != null && session.role !== session.title ? (
              <span className="ml-1.5 text-ink-faint">· {session.role}</span>
            ) : null}
            {session && running ? (
              <span className="ml-1.5 text-ink-faint">· running</span>
            ) : null}
            {session && !running ? (
              <span className="ml-1.5 text-ink-faint">
                {session.exitCode == null ? "· stopped" : `· exit ${session.exitCode}`}
              </span>
            ) : null}
          </button>
        )}

        <div className="flex shrink-0 items-center gap-1">
          {session && session.kind !== "shell" ? (
            <PermissionModeChip session={session} />
          ) : null}
          {session ? <ViewSwitch session={session} paneId={paneId} /> : null}
          <div className="flex items-center">
            {session ? (
              <>
                {view === "terminal" && (
                  <QuietButton label="Clear" onClick={() => clearTerminal(session.id)} />
                )}
                {running ? (
                  <QuietButton label="Stop" onClick={() => void stopSession(session.id)} />
                ) : (
                  <QuietButton label="Restart" onClick={restart} disabled={busy} />
                )}
                <QuietButton label="Close" onClick={() => void closeSession(session.id)} />
              </>
            ) : null}
            <QuietButton
              label={isMaximized ? "Restore" : "Expand"}
              onClick={() => toggleMaximized(paneId)}
            />
          </div>
        </div>
      </header>

      {session ? (
        view === "graph" ? (
          <Suspense fallback={<div className="min-h-0 flex-1" />}>
            <GraphVisualizer session={session} compact />
          </Suspense>
        ) : view === "steps" ? (
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

export default memo(TerminalPane);
export { TerminalPane };
