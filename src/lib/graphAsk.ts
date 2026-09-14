/**
 * Asking a session to write its graph file.
 */

import type { Session } from "../types";
import { talkToSession } from "./talkToSession";

export const GRAPH_REQUEST =
  "Write your plan for this work as a graph to $GROKSPACE_GRAPH_FILE now, " +
  "then keep the node statuses in that file up to date as you go.";

/** Whether this session can be asked for a graph right now. */
export function canAskForGraph(session: Session): boolean {
  if (session.kind === "grok") return session.status === "running";
  // Idle only: a second `session/prompt` while one is in flight would stack.
  if (session.kind === "agent") return session.status === "idle";
  return false;
}

export async function askForGraph(session: Session): Promise<void> {
  await talkToSession(session, GRAPH_REQUEST);
}
