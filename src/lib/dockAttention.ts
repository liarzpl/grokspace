/**
 * Dock badge and a single Informational bounce for an unfocused ACP wait.
 *
 * A focused window already has Allow/Deny on the card, so native attention is
 * withheld then. Pty sessions cannot report `needs_input` — they have pixels,
 * not a status — and are ignored even if a caller passes one. Bounce is once
 * per wait: a second permission on the same session does not bounce again
 * until that session has left `needs_input`.
 */

import type { Session, SessionKind, SessionStatus } from "../types";

/** The fields the dock cares about; the rest of a session is irrelevant. */
export type DockSession = Pick<Session, "id" | "kind" | "status">;

/**
 * Native calls the tracker makes. App supplies Tauri; tests supply fakes.
 * There is no Critical path: that would bounce until focus, which is not
 * what an Informational wait is.
 */
export interface DockNative {
  setBadgeCount: (count: number | undefined) => void;
  requestUserAttention: () => void;
}

export interface DockTracker {
  setFocused: (focused: boolean, sessions: readonly DockSession[], native: DockNative) => void;
  /** Badge only; bounce is a transition, not a snapshot. */
  apply: (sessions: readonly DockSession[], native: DockNative) => void;
  /**
   * `status` is the arriving status, not necessarily what the store already
   * shows. A permission event is `needs_input` even if `session-status` has
   * not landed yet — the backend emits permission first.
   */
  note: (
    sessionId: string,
    status: SessionStatus,
    sessions: readonly DockSession[],
    native: DockNative,
  ) => void;
}

/** Unfocused ACP waits, or `undefined` to clear. `0` would draw a zero. */
export function dockBadgeCount(
  sessions: readonly Pick<Session, "kind" | "status">[],
  focused: boolean,
): number | undefined {
  if (focused) return undefined;
  let count = 0;
  for (const session of sessions) {
    if (session.kind === "agent" && session.status === "needs_input") count += 1;
  }
  return count === 0 ? undefined : count;
}

/**
 * One Informational bounce per wait. Entering `needs_input` while focused is
 * remembered so a later permission on the same wait, now unfocused, does not
 * bounce — that was not a new transition into the wait.
 */
export function attentionAfter(
  session: { id: string; kind: SessionKind },
  status: SessionStatus,
  focused: boolean,
  bounced: ReadonlySet<string>,
): { bounce: boolean; bounced: Set<string> } {
  const next = new Set(bounced);
  const waiting = session.kind === "agent" && status === "needs_input";
  if (!waiting) {
    next.delete(session.id);
    return { bounce: false, bounced: next };
  }
  if (next.has(session.id) || focused) {
    next.add(session.id);
    return { bounce: false, bounced: next };
  }
  next.add(session.id);
  return { bounce: true, bounced: next };
}

/**
 * Live tracker for the main window. Focus starts true so a wait that arrives
 * before `isFocused()` resolves does not bounce by accident.
 */
export function createDockTracker(): DockTracker {
  let focused = true;
  let bounced = new Set<string>();

  function forgetGone(sessions: readonly DockSession[]) {
    const live = new Set(sessions.map((session) => session.id));
    for (const id of bounced) {
      if (!live.has(id)) bounced.delete(id);
    }
  }

  function apply(sessions: readonly DockSession[], native: DockNative) {
    forgetGone(sessions);
    native.setBadgeCount(dockBadgeCount(sessions, focused));
  }

  return {
    setFocused(next, sessions, native) {
      focused = next;
      apply(sessions, native);
    },
    apply,
    note(sessionId, status, sessions, native) {
      const session = sessions.find((item) => item.id === sessionId);
      if (session === undefined) {
        bounced.delete(sessionId);
        apply(sessions, native);
        return;
      }
      const result = attentionAfter(session, status, focused, bounced);
      bounced = result.bounced;
      if (result.bounce) native.requestUserAttention();
      apply(sessions, native);
    },
  };
}
