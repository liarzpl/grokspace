/**
 * Typed wrappers around the backend events, so the frontend never spells out
 * raw event names or payload shapes. Commands already go through `api.ts`;
 * this is that façade for `listen`.
 */

import type { AgentUpdate, AgentUpdateKind, PermissionRequest, SessionStatus } from "../types";

export const EVENTS = {
  sessionExited: "session-exited",
  sessionStatus: "session-status",
  sessionPermission: "session-permission",
  sessionIsolation: "session-isolation",
  sessionUpdate: "session-update",
  graphChanged: "graph-changed",
  stepsChanged: "steps-changed",
  tasksChanged: "tasks-changed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export const EVENT_NAMES: readonly EventName[] = Object.values(EVENTS);

export interface SessionExited {
  id: string;
  exitCode: number | null;
}

export interface SessionStatusChanged {
  id: string;
  status: SessionStatus;
}

export interface PermissionAsked extends PermissionRequest {
  id: string;
}

export interface IsolationFailed {
  id: string;
  reason: string;
}

export interface SessionUpdated {
  id: string;
  kind: AgentUpdateKind;
  text: string;
}

/** The backend also reports `path` and `removed`; the re-read covers both. */
export interface GraphChanged {
  sessionId: string;
  path?: string;
  removed?: boolean;
}

export interface StepsChanged {
  sessionId: string;
}

export interface TasksChanged {
  projectId: string;
}

export type Unlisten = () => void;

export type ListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<Unlisten>;

/** The fields the bus needs to decide whether a session is still on screen. */
export interface EventSession {
  id: string;
  status: SessionStatus;
}

export interface BackendEventHandlers {
  markExited: (id: string, exitCode: number | null) => void;
  markStatus: (id: string, status: SessionStatus) => void;
  askPermission: (id: string, request: PermissionRequest) => void;
  noteIsolation: (id: string, reason: string) => void;
  appendUpdate: (id: string, update: AgentUpdate) => void;
  sessions: () => readonly EventSession[];
  refreshGraph: (sessionId: string, isOpen: boolean) => void;
  refreshSteps: (sessionId: string, isOpen: boolean) => void;
  activeProjectId: () => string | null;
  loadTasks: (projectId: string) => void;
  noteDock?: (id: string, status: SessionStatus) => void;
}

function isOpen(sessions: readonly EventSession[], id: string): boolean {
  return sessions.some((session) => session.id === id);
}

/**
 * One subscribe for every backend event App used to register by hand.
 * A fake `listen` is enough to test the wiring without a webview.
 */
export async function listenBackendEvents(
  listen: ListenFn,
  handlers: BackendEventHandlers,
): Promise<Unlisten> {
  const stops = await Promise.all([
    listen<SessionExited>(EVENTS.sessionExited, (event) => {
      handlers.markExited(event.payload.id, event.payload.exitCode);
      handlers.noteDock?.(event.payload.id, "stopped");
    }),
    listen<SessionStatusChanged>(EVENTS.sessionStatus, (event) => {
      const current = handlers.sessions().find((session) => session.id === event.payload.id);
      // Closed or already-stopped ids: a late ACP status must not revive them
      // or bounce the dock for a process that has gone.
      if (current === undefined || current.status === "stopped") return;
      handlers.markStatus(event.payload.id, event.payload.status);
      handlers.noteDock?.(event.payload.id, event.payload.status);
    }),
    listen<PermissionAsked>(EVENTS.sessionPermission, (event) => {
      const { id, requestId, summary, options } = event.payload;
      handlers.askPermission(id, {
        requestId,
        summary,
        options: options ?? [],
      });
      handlers.noteDock?.(id, "needs_input");
    }),
    listen<IsolationFailed>(EVENTS.sessionIsolation, (event) => {
      handlers.noteIsolation(event.payload.id, event.payload.reason);
    }),
    listen<SessionUpdated>(EVENTS.sessionUpdate, (event) => {
      const { id, kind, text } = event.payload;
      if (text === "" || kind === "prompt") return;
      handlers.appendUpdate(id, { kind, text });
    }),
    listen<GraphChanged>(EVENTS.graphChanged, (event) => {
      const { sessionId } = event.payload;
      handlers.refreshGraph(sessionId, isOpen(handlers.sessions(), sessionId));
    }),
    listen<StepsChanged>(EVENTS.stepsChanged, (event) => {
      const { sessionId } = event.payload;
      handlers.refreshSteps(sessionId, isOpen(handlers.sessions(), sessionId));
    }),
    listen<TasksChanged>(EVENTS.tasksChanged, (event) => {
      if (handlers.activeProjectId() !== event.payload.projectId) return;
      handlers.loadTasks(event.payload.projectId);
    }),
  ]);

  return () => {
    for (const stop of stops) stop();
  };
}
