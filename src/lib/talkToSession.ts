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
