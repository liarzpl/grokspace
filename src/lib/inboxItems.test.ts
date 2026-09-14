import { describe, expect, it } from "vitest";

import { session, task } from "../test/fixtures";
import type { PermissionRequest, Session } from "../types";
import { inboxItems, type InboxItem, type InboxReadiness } from "./inboxItems";

function agent(overrides: Partial<Session> = {}): Session {
  return session({
    kind: "agent",
    paneId: null,
    title: "Agent",
    worktreePath: null,
    ...overrides,
  });
}

const ask: PermissionRequest = { requestId: 1, summary: "Edit src/a.ts" };

function ids(items: InboxItem[]) {
  return items.map(({ id, split, jump, taskId }) => ({ id, split, jump, taskId }));
}

describe("inboxItems", () => {
  it.each([
    {
      name: "needs_input + assigned card",
      sessions: [agent({ status: "needs_input" })],
      tasks: [task({ assignedSessionId: "s1" })],
      permissions: {},
      readiness: {},
      want: [{ id: "s1", split: "needs_you", jump: "card", taskId: "t1" }],
    },
    {
      name: "pending permission before status",
      sessions: [agent({ status: "running" })],
      tasks: [],
      permissions: { s1: [ask] },
      readiness: {},
      want: [{ id: "s1", split: "needs_you", jump: "graph", taskId: null }],
    },
    {
      name: "ignores pty",
      sessions: [session({ kind: "grok", status: "needs_input" })],
      tasks: [],
      permissions: { s1: [ask] },
      readiness: {},
      want: [],
    },
    {
      name: "idle + approved steps → Review / graph",
      sessions: [agent({ status: "idle" })],
      tasks: [],
      permissions: {},
      readiness: { s1: { phase: "approved" } },
      want: [{ id: "s1", split: "review", jump: "graph", taskId: null }],
    },
    {
      name: "idle + dirty isolated tree → Review / Diff",
      sessions: [agent({ status: "idle", worktreePath: "/tmp/t" })],
      tasks: [],
      permissions: {},
      readiness: { s1: { dirty: true } },
      want: [{ id: "s1", split: "review", jump: "diff", taskId: null }],
    },
    {
      name: "idle isolated without dirty or approved",
      sessions: [agent({ status: "idle", worktreePath: "/tmp/t" })],
      tasks: [],
      permissions: {},
      readiness: {},
      want: [],
    },
    {
      name: "stopped + worktree + null readiness → Merge / Diff",
      sessions: [agent({ status: "stopped", worktreePath: "/tmp/t" })],
      tasks: [],
      permissions: {},
      readiness: { s1: { merge: null } },
      want: [{ id: "s1", split: "merge", jump: "diff", taskId: null }],
    },
    {
      name: "Merge refusal and unknown readiness stay off",
      sessions: [agent({ status: "stopped", worktreePath: "/tmp/t" })],
      tasks: [],
      permissions: {},
      readiness: { s1: { merge: "commit or stash the project first" } },
      want: [],
    },
    {
      name: "unknown Merge readiness stays off",
      sessions: [agent({ status: "stopped", worktreePath: "/tmp/t" })],
      tasks: [],
      permissions: {},
      readiness: {},
      want: [],
    },
    {
      name: "Needs you wins over Review",
      sessions: [agent({ status: "needs_input", worktreePath: "/tmp/t" })],
      tasks: [],
      permissions: {},
      readiness: { s1: { phase: "approved", dirty: true } },
      want: [{ id: "s1", split: "needs_you", jump: "graph", taskId: null }],
    },
    {
      name: "empty",
      sessions: [],
      tasks: [],
      permissions: {},
      readiness: {},
      want: [],
    },
  ])("$name", ({ sessions, tasks, permissions, readiness, want }) => {
    expect(ids(inboxItems(sessions, tasks, permissions, readiness as InboxReadiness))).toEqual(
      want,
    );
  });

  it("orders Needs you, then Review, then Merge", () => {
    const items = inboxItems(
      [
        agent({ id: "merge", status: "stopped", title: "Merger", worktreePath: "/tmp/m" }),
        agent({ id: "wait-b", status: "needs_input", title: "B" }),
        agent({ id: "rev", status: "idle", title: "Reviewer" }),
        agent({ id: "wait-a", status: "needs_input", title: "A" }),
      ],
      [],
      {},
      { merge: { merge: null }, rev: { phase: "approved" } },
    );
    expect(items.map((item) => item.id)).toEqual(["wait-b", "wait-a", "rev", "merge"]);
  });

  it("uses Agent when the title is blank", () => {
    expect(inboxItems([agent({ status: "needs_input", title: "  " })], [], {}, {})[0]?.title).toBe(
      "Agent",
    );
  });

  it("hides a snoozed Needs you wait and returns it when the timer ends", () => {
    const sessions = [agent({ status: "needs_input" })];
    expect(ids(inboxItems(sessions, [], {}, {}, { s1: 200 }, 100))).toEqual([]);
    expect(ids(inboxItems(sessions, [], {}, {}, { s1: 200 }, 200))).toEqual([
      { id: "s1", split: "needs_you", jump: "graph", taskId: null },
    ]);
  });

  it("does not hide Review or Merge under a leftover snooze", () => {
    expect(
      ids(
        inboxItems(
          [agent({ status: "idle" })],
          [],
          {},
          { s1: { phase: "approved" } },
          { s1: 999 },
          1,
        ),
      ),
    ).toEqual([{ id: "s1", split: "review", jump: "graph", taskId: null }]);
  });
});
