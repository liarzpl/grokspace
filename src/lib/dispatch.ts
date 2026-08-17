/**
 * Where a task can be sent, and in what order.
 *
 * Lifted out of `TaskBoard` when the `defaultDispatch` preference arrived. Until then
 * this was presentation — walk the grid, list what is there — and it could live beside
 * the markup that drew it. A preference turns it into a decision, and a decision that
 * changes what a click reaches wants a test more than it wants to be near its JSX.
 */

import { layoutOf } from "../stores/projectStore";
import { sessionForPane } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { paneCount, type Project, type Session } from "../types";

/** Something already running, a free pane to start a terminal in, or a new agent. */
export type DispatchTarget =
  | { kind: "session"; session: Session }
  | { kind: "pane"; paneId: string }
  | { kind: "agent" };

export function targetKey(target: DispatchTarget): string {
  if (target.kind === "session") return target.session.id;
  return target.kind === "agent" ? "new-agent" : `pane-${target.paneId}`;
}

export function targetLabel(target: DispatchTarget): string {
  if (target.kind === "agent") return "New agent";
  if (target.kind === "pane") return `${Number(target.paneId) + 1} · Start Grok`;
  const pane = target.session.paneId === null ? "" : `${Number(target.session.paneId) + 1} · `;
  return `${pane}${target.session.title ?? "Session"}`;
}

/** The pane a new session should start in, or `null` to ask for a paneless agent. */
export function paneOf(target: DispatchTarget): string | null {
  return target.kind === "pane" ? target.paneId : null;
}

/** Whether a session in this state can be given work; agents reach more of these. */
function canTake(session: Session): boolean {
  return (
    session.kind !== "shell" && (session.status === "running" || session.status === "idle")
  );
}

/**
 * Panes in grid order, then agents already running, and a new agent at one end.
 *
 * A pane holding a stopped session is not offered — restarting it is a decision about
 * that terminal, not about this task — and nor is a shell, which would try to run the
 * task rather than read it.
 *
 * The new agent is always available, since it needs no pane and a full grid cannot
 * take it away, and it is the one target that can report what it is doing. Whether it
 * sits first or last is the `defaultDispatch` preference. Reordering only: a setting
 * that picked the target for you would be a setting that quietly sends work somewhere
 * nobody looked.
 */
export function dispatchTargets(project: Project, sessions: Session[]): DispatchTarget[] {
  const panes = Array.from({ length: paneCount(layoutOf(project)) }, (_, index) =>
    String(index),
  );

  const inPanes = panes.flatMap((paneId): DispatchTarget[] => {
    const session = sessionForPane(sessions, paneId);
    if (session === undefined) return [{ kind: "pane", paneId }];
    return canTake(session) ? [{ kind: "session", session }] : [];
  });

  // Agents hold no pane, so walking the grid does not find them.
  const agents: DispatchTarget[] = sessions
    .filter((session) => session.kind === "agent" && canTake(session))
    .map((session) => ({ kind: "session", session }));

  const newAgent: DispatchTarget = { kind: "agent" };
  const prefersAgent = useSettingsStore.getState().settings.defaultDispatch === "agent";
  return prefersAgent ? [newAgent, ...inPanes, ...agents] : [...inPanes, ...agents, newAgent];
}
