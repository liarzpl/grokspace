/**
 * Folding and capping an ACP session's visible output.
 *
 * Message and thought chunks arrive as a stream of fragments; concatenating
 * consecutive ones of the same kind is what makes a sentence rather than a
 * staircase of one-word lines. A plan replaces the previous plan. Everything
 * else is a discrete event. The store keeps up to `TRANSCRIPT_CAP` records;
 * the Graph / Tasks transcript only mounts a tail of those.
 */

import type { AgentUpdate, AgentUpdateKind } from "../types";

/** Enough for a long turn; dropping the oldest is better than growing forever. */
export const TRANSCRIPT_CAP = 400;

/** Rows in the DOM at once. Older history stays in the store until asked for. */
export const TRANSCRIPT_WINDOW = 80;

export const MORE_TRANSCRIPT_ROWS = 80;

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

/**
 * Newest `limit` entries, plus how many older ones stay unmounted. A streaming
 * transcript follows the tail; "show earlier" raises `limit`.
 */
export function windowTranscript<T>(
  entries: readonly T[],
  limit: number,
): { shown: readonly T[]; offset: number; hidden: number } {
  if (limit < 1) {
    return { shown: [], offset: entries.length, hidden: entries.length };
  }
  if (entries.length <= limit) {
    return { shown: entries, offset: 0, hidden: 0 };
  }
  const offset = entries.length - limit;
  return { shown: entries.slice(offset), offset, hidden: offset };
}

export function growTranscriptWindow(current: number, total: number): number {
  return Math.min(total, current + MORE_TRANSCRIPT_ROWS);
}

/** Stable until the store drops the oldest record at `TRANSCRIPT_CAP`. */
export function transcriptRowKey(absoluteIndex: number, kind: AgentUpdateKind): string {
  return `${absoluteIndex}:${kind}`;
}
