import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { Session } from "../types";
import {
  attentionAfter,
  createDockTracker,
  dockBadgeCount,
  type DockNative,
} from "./dockAttention";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "a1",
    projectId: "p1",
    paneId: null,
    processId: 1,
    status: "running",
    title: "Agent",
    role: null,
    worktreePath: "/tmp/t",
    kind: "agent",
    exitCode: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function native(): DockNative & { badge: ReturnType<typeof vi.fn>; bounce: ReturnType<typeof vi.fn> } {
  const badge = vi.fn();
  const bounce = vi.fn();
  return {
    badge,
    bounce,
    setBadgeCount: badge,
    requestUserAttention: bounce,
  };
}

describe("dockBadgeCount", () => {
  it("clears when the window is focused, even if agents are waiting", () => {
    expect(
      dockBadgeCount(
        [
          session({ status: "needs_input" }),
          session({ id: "a2", status: "needs_input" }),
        ],
        true,
      ),
    ).toBeUndefined();
  });

  it("counts unfocused ACP waits, and clears rather than drawing zero", () => {
    expect(dockBadgeCount([session({ status: "needs_input" })], false)).toBe(1);
    expect(
      dockBadgeCount(
        [session({ status: "needs_input" }), session({ id: "a2", status: "needs_input" })],
        false,
      ),
    ).toBe(2);
    expect(dockBadgeCount([session({ status: "idle" })], false)).toBeUndefined();
    expect(dockBadgeCount([], false)).toBeUndefined();
  });

  it("ignores pty sessions, which cannot be waiting on a person", () => {
    expect(
      dockBadgeCount(
        [
          session({ kind: "grok", paneId: "0", status: "needs_input" }),
          session({ id: "sh", kind: "shell", paneId: "1", status: "needs_input" }),
          session({ id: "a2", status: "needs_input" }),
        ],
        false,
      ),
    ).toBe(1);
  });
});

describe("attentionAfter", () => {
  it("bounces once per wait while unfocused", () => {
    const first = attentionAfter(session(), "needs_input", false, new Set());
    expect(first.bounce).toBe(true);
    const second = attentionAfter(session(), "needs_input", false, first.bounced);
    expect(second.bounce).toBe(false);
  });

  it("bounces again only after the session has left needs_input", () => {
    const waiting = attentionAfter(session(), "needs_input", false, new Set());
    const idle = attentionAfter(session(), "idle", false, waiting.bounced);
    expect(idle.bounce).toBe(false);
    expect(idle.bounced.has("a1")).toBe(false);
    const again = attentionAfter(session(), "needs_input", false, idle.bounced);
    expect(again.bounce).toBe(true);
  });

  it("does not bounce when focused, but remembers the wait", () => {
    const focused = attentionAfter(session(), "needs_input", true, new Set());
    expect(focused.bounce).toBe(false);
    expect(focused.bounced.has("a1")).toBe(true);
    const later = attentionAfter(session(), "needs_input", false, focused.bounced);
    expect(later.bounce).toBe(false);
  });

  it("never bounces for a terminal", () => {
    const grok = attentionAfter(
      session({ kind: "grok", paneId: "0" }),
      "needs_input",
      false,
      new Set(),
    );
    expect(grok.bounce).toBe(false);
    expect(grok.bounced.has("a1")).toBe(false);
  });
});

describe("createDockTracker", () => {
  it("shows a badge and bounces once when an unfocused agent starts waiting", () => {
    const dock = createDockTracker();
    const calls = native();
    const waiting = [session({ status: "needs_input" })];

    dock.setFocused(false, [session()], calls);
    expect(calls.badge).toHaveBeenLastCalledWith(undefined);
    expect(calls.bounce).not.toHaveBeenCalled();

    dock.note("a1", "needs_input", waiting, calls);
    expect(calls.badge).toHaveBeenLastCalledWith(1);
    expect(calls.bounce).toHaveBeenCalledOnce();

    dock.note("a1", "needs_input", waiting, calls);
    expect(calls.bounce).toHaveBeenCalledOnce();
  });

  it("treats a permission as needs_input even if the status event has not landed", () => {
    const dock = createDockTracker();
    const calls = native();
    dock.setFocused(false, [session()], calls);

    dock.note("a1", "needs_input", [session({ status: "running" })], calls);
    expect(calls.bounce).toHaveBeenCalledOnce();

    dock.note("a1", "needs_input", [session({ status: "needs_input" })], calls);
    expect(calls.bounce).toHaveBeenCalledOnce();
    expect(calls.badge).toHaveBeenLastCalledWith(1);
  });

  it("bounces each waiting agent once, and counts them", () => {
    const dock = createDockTracker();
    const calls = native();
    dock.setFocused(false, [], calls);

    dock.note("a1", "needs_input", [session({ status: "needs_input" })], calls);
    dock.note(
      "a2",
      "needs_input",
      [session({ status: "needs_input" }), session({ id: "a2", status: "needs_input" })],
      calls,
    );

    expect(calls.bounce).toHaveBeenCalledTimes(2);
    expect(calls.badge).toHaveBeenLastCalledWith(2);
  });

  it("clears the badge on focus and restores it on blur without bouncing again", () => {
    const dock = createDockTracker();
    const calls = native();
    const waiting = [session({ status: "needs_input" })];
    dock.setFocused(false, [session()], calls);
    dock.note("a1", "needs_input", waiting, calls);

    dock.setFocused(true, waiting, calls);
    expect(calls.badge).toHaveBeenLastCalledWith(undefined);
    dock.setFocused(false, waiting, calls);
    expect(calls.badge).toHaveBeenLastCalledWith(1);
    expect(calls.bounce).toHaveBeenCalledOnce();
  });

  it("clears a wait that has stopped, and a session that is gone", () => {
    const dock = createDockTracker();
    const calls = native();
    dock.setFocused(false, [session()], calls);
    dock.note("a1", "needs_input", [session({ status: "needs_input" })], calls);

    dock.note("a1", "stopped", [session({ status: "stopped" })], calls);
    expect(calls.badge).toHaveBeenLastCalledWith(undefined);

    dock.note("a1", "needs_input", [session({ status: "needs_input" })], calls);
    expect(calls.bounce).toHaveBeenCalledTimes(2);

    dock.apply([], calls);
    expect(calls.badge).toHaveBeenLastCalledWith(undefined);
  });

  it("does not bounce a wait that began while focused", () => {
    const dock = createDockTracker();
    const calls = native();
    const waiting = [session({ status: "needs_input" })];
    dock.note("a1", "needs_input", waiting, calls);
    expect(calls.bounce).not.toHaveBeenCalled();
    expect(calls.badge).toHaveBeenLastCalledWith(undefined);

    dock.setFocused(false, waiting, calls);
    expect(calls.badge).toHaveBeenLastCalledWith(1);
    dock.note("a1", "needs_input", waiting, calls);
    expect(calls.bounce).not.toHaveBeenCalled();
  });
});

describe("the Overlay window capability", () => {
  it("allows badge and Informational attention, and nothing from a notification plugin", () => {
    const capPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../src-tauri/capabilities/default.json",
    );
    const cap = JSON.parse(readFileSync(capPath, "utf8")) as { permissions: string[] };
    const windowAllows = cap.permissions.filter((permission) =>
      permission.startsWith("core:window:allow-"),
    );

    expect(windowAllows).toEqual([
      "core:window:allow-start-dragging",
      "core:window:allow-set-badge-count",
      "core:window:allow-request-user-attention",
    ]);
    expect(cap.permissions.some((permission) => permission.includes("notification"))).toBe(
      false,
    );
  });
});
