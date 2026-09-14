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

export async function talkToSession(session: Session, text: string): Promise<void> {
  if (session.kind === "agent") {
    await api.promptSession(session.id, text);
    return;
  }
  await api.writeSession(session.id, `${text}\r`);
}
