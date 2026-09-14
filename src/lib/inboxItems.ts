/**
 * Attention inbox: Needs you / Review / Merge from data the shell already has.
 *
 * Not a sixth workspace tab and not a second Kanban. Clicking jumps to the
 * task card, the Diff chip, or the graph. Dispatch is not gated here.
 */

import type { PermissionRequest, Session, StepsPhase, Task } from "../types";

export const INBOX_SPLITS = [
  { id: "needs_you", label: "Needs you" },
  { id: "review", label: "Review" },
  { id: "merge", label: "Merge" },
] as const;

export type InboxSplit = (typeof INBOX_SPLITS)[number]["id"];
export type InboxJump = "card" | "diff" | "graph";

/** Per-session Merge readiness, steps phase, and isolated-tree dirtiness. */
export interface SessionInboxReadiness {
  /** `sessionMergeReadiness`: `null` is ready; a string is why Merge would refuse. */
  merge?: string | null;
  phase?: StepsPhase;
  dirty?: boolean;
}

export type InboxReadiness = Readonly<Record<string, SessionInboxReadiness | undefined>>;

export interface InboxItem {
  id: string;
  split: InboxSplit;
  title: string;
  taskId: string | null;
  jump: InboxJump;
}

const SPLIT_ORDER: readonly InboxSplit[] = INBOX_SPLITS.map((split) => split.id);

function itemTitle(session: Pick<Session, "title">): string {
  const title = session.title?.trim();
  return title !== undefined && title !== "" ? title : "Agent";
}

function classify(
  session: Pick<Session, "id" | "kind" | "status" | "title" | "worktreePath">,
  tasks: readonly Pick<Task, "id" | "assignedSessionId">[],
  permissions: Readonly<Record<string, readonly PermissionRequest[] | undefined>>,
  readiness: InboxReadiness,
): InboxItem | null {
  if (session.kind !== "agent") return null;

  const taskId = tasks.find((task) => task.assignedSessionId === session.id)?.id ?? null;
  const info = readiness[session.id];
  const base = { id: session.id, title: itemTitle(session), taskId };

  if (session.status === "needs_input" || (permissions[session.id]?.length ?? 0) > 0) {
    return { ...base, split: "needs_you", jump: taskId !== null ? "card" : "graph" };
  }

  if (session.status === "idle") {
    const approved = info?.phase === "approved";
    const dirty = session.worktreePath !== null && info?.dirty === true;
    if (approved || dirty) {
      return { ...base, split: "review", jump: dirty ? "diff" : "graph" };
    }
  }

  if (session.status === "stopped" && session.worktreePath !== null && info?.merge === null) {
    return { ...base, split: "merge", jump: "diff" };
  }

  return null;
}

/**
 * One item per agent, exclusive: Needs you, then Review, then Merge.
 * Pty sessions cannot wait on a person and are ignored.
 */
export function inboxItems(
  sessions: readonly Pick<Session, "id" | "kind" | "status" | "title" | "worktreePath">[],
  tasks: readonly Pick<Task, "id" | "assignedSessionId">[],
  permissions: Readonly<Record<string, readonly PermissionRequest[] | undefined>>,
  readiness: InboxReadiness,
): InboxItem[] {
  const items: InboxItem[] = [];
  for (const session of sessions) {
    const item = classify(session, tasks, permissions, readiness);
    if (item !== null) items.push(item);
  }
  return items.sort(
    (left, right) => SPLIT_ORDER.indexOf(left.split) - SPLIT_ORDER.indexOf(right.split),
  );
}
