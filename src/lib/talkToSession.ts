/**
 * Talking to a session: an ACP agent is prompted, a terminal is typed at.
 *
 * The two cannot share a write path. `writeSession` is a pty, and a pane-less
 * agent has none. A trailing CR submits on a TUI the way Enter would; forgetting
 * it is a silent no-op. A second kind, or a change to how Grok TUI submits,
 * should land here rather than at every caller.
 */

import { api } from "./api";
import type { Session } from "../types";

/** A baton prompt names a slice of the source transcript, never the whole log. */
export const BATON_EXCERPT_BYTES = 2 * 1024;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Host brief after Continue this job. Restart-shaped start already reused the
 * tree and minted a new id; this is what the new ACP mind is told. Graph path
 * and step titles, never the full transcript. One line: a newline submits.
 */
export function handoffPrompt(input: {
  graphPath: string;
  stepTitles: readonly string[];
  excerpt: string;
}): string {
  const parts = [
    "Continue this job on the same worktree. This is a new conversation, not a resumed grok thread.",
    "Read $GROKSPACE_MEMORY_FILE.",
    `The previous graph is at ${oneLine(input.graphPath)} (read-only; do not write it).`,
    "Your own graph is $GROKSPACE_GRAPH_FILE.",
  ];
  if (input.stepTitles.length > 0) {
    const titles = input.stepTitles
      .map((title, index) => `${index + 1}. ${oneLine(title)}`)
      .join(" ");
    parts.push(`Steps: ${titles}.`);
  }
  const excerpt = oneLine(input.excerpt);
  if (excerpt !== "") {
    parts.push(`Excerpt: ${excerpt}`);
  }
  return parts.join(" ");
}

/**
 * The tail of a transcript, flattened to one line and capped at 2 KiB.
 * A newline would submit in a TUI; the cap is bytes on the wire, not UTF-16.
 */
export function transcriptExcerpt(
  updates: readonly { text: string }[],
  maxBytes = BATON_EXCERPT_BYTES,
): string {
  const flat = updates
    .map((update) => update.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "" || maxBytes <= 0) return "";
  const encoded = new TextEncoder().encode(flat);
  if (encoded.length <= maxBytes) return flat;
  const slice = encoded.slice(encoded.length - maxBytes);
  let start = 0;
  while (start < slice.length && (slice[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return new TextDecoder().decode(slice.subarray(start));
}

export async function talkToSession(session: Session, text: string): Promise<void> {
  if (session.kind === "agent") {
    await api.promptSession(session.id, text);
    return;
  }
  await api.writeSession(session.id, `${text}\r`);
}
