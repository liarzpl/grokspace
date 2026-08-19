/**
 * Folding and capping an ACP session's visible output.
 *
 * Message and thought chunks arrive as a stream of fragments; concatenating
 * consecutive ones of the same kind is what makes a sentence rather than a
 * staircase of one-word lines. A plan replaces the previous plan. Everything
 * else is a discrete event.
 */

import type { AgentUpdate } from "../types";

/** Enough for a long turn; dropping the oldest is better than growing forever. */
export const TRANSCRIPT_CAP = 400;

export function foldUpdate(entries: AgentUpdate[], next: AgentUpdate): AgentUpdate[] {
  const last = entries[entries.length - 1];
  let folded: AgentUpdate[];

  if (
    last !== undefined &&
    last.kind === next.kind &&
    (next.kind === "message" || next.kind === "thought")
  ) {
    folded = [...entries.slice(0, -1), { kind: last.kind, text: last.text + next.text }];
  } else if (last?.kind === "plan" && next.kind === "plan") {
    folded = [...entries.slice(0, -1), next];
  } else {
    folded = [...entries, next];
  }

  if (folded.length <= TRANSCRIPT_CAP) return folded;
  return folded.slice(folded.length - TRANSCRIPT_CAP);
}
