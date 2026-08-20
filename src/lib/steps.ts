/**
 * Approving a session's step list, and the small amounts of progress the board
 * and pane switch need to show.
 *
 * A terminal Grok is typed at; an ACP agent is prompted. The two cannot share a
 * write path: `writeSession` is a pty, and a pane-less agent has none. The prompt
 * is one line because a newline submits in a TUI.
 */

import { api } from "./api";
import type { Session, SessionStep, StepsPhase } from "../types";

/** How many titles a session's list will hold. Matches the backend cap. */
export const MAX_STEPS = 20;

/**
 * Whether Approve should be offered for this session right now.
 *
 * Agents are idle-only: a second `session/prompt` while one is in flight would
 * stack. A Grok terminal is always typed at, so `running` is the ready state.
 * A shell has no steps face at all.
 */
export function canApproveSteps(
  session: Session,
  phase: StepsPhase,
  count: number,
): boolean {
  if (phase !== "proposed" || count === 0) return false;
  if (session.kind === "grok") return session.status === "running";
  if (session.kind === "agent") return session.status === "idle";
  return false;
}

/** Sessions that own a step list. Shells do not. */
export function sessionsWithSteps(sessions: readonly Session[]): Session[] {
  return sessions.filter((session) => session.kind === "grok" || session.kind === "agent");
}

export function approvalPrompt(steps: readonly SessionStep[]): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const titles = steps
    .map((step, index) => `${index + 1}. ${oneLine(step.title)}`)
    .join(" ");
  return `Approved. Continue as written: ${titles}`;
}

export async function sendApproval(
  session: Session,
  steps: readonly SessionStep[],
): Promise<void> {
  const text = approvalPrompt(steps);
  if (session.kind === "agent") {
    await api.promptSession(session.id, text);
    return;
  }
  await api.writeSession(session.id, `${text}\r`);
}

/**
 * Done against the length of the list, or null when there is nothing to count.
 * Skipped items are not done: they were deliberately not done.
 *
 * A non-empty list returns a new object every call. Do not use this as a Zustand
 * selector: React 19's `useSyncExternalStore` loops if `getSnapshot` returns a
 * fresh reference. Select the steps array and count in render instead.
 */
export function stepProgress(
  steps: readonly SessionStep[],
): { done: number; total: number } | null {
  if (steps.length === 0) return null;
  return {
    done: steps.filter((step) => step.status === "done").length,
    total: steps.length,
  };
}
