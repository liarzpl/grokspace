/**
 * Approving a session's step list, and the small amounts of progress the board
 * and pane switch need to show.
 *
 * The prompt is one line because a newline submits in a TUI. Sending it goes
 * through `talkToSession`.
 */

import type { Session, SessionStep, StepsPhase } from "../types";
import { MAX_STEPS } from "./limits";
import { talkToSession } from "./talkToSession";

export { MAX_STEPS };

/** Visible names for the steps phase. Spec is `proposed`; Build is `approved`. */
export const STEPS_MODES = ["spec", "build"] as const;
export type StepsMode = (typeof STEPS_MODES)[number];

export const STEPS_MODE_LABEL: Record<StepsMode, string> = {
  spec: "Spec",
  build: "Build",
};

/**
 * Spec | Build chip from the session's steps phase. `none` has no named mode.
 * The phase strings stay `proposed` / `approved`; only the chrome is renamed.
 */
export function stepsMode(phase: StepsPhase): StepsMode | null {
  if (phase === "proposed") return "spec";
  if (phase === "approved") return "build";
  return null;
}

export function stepsModeLabel(phase: StepsPhase): string | null {
  const mode = stepsMode(phase);
  return mode === null ? null : STEPS_MODE_LABEL[mode];
}

/**
 * Whether Build (the existing Approve path) should be offered for this session
 * right now.
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
  await talkToSession(session, approvalPrompt(steps));
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
