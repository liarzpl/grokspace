import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const writeInboxSnooze = vi.fn();
const readInboxSnooze = vi.fn();

vi.mock("./api", () => ({
  api: {
    writeInboxSnooze: (...args: unknown[]) => writeInboxSnooze(...args),
    readInboxSnooze: (...args: unknown[]) => readInboxSnooze(...args),
  },
}));

const { hydrateInboxSnooze, isSnoozed, pruneSnooze, snoozeUntil, snoozeWait, wakeInboxSnooze } =
  await import("./inboxSnooze");
const { useUiStore } = await import("../stores/uiStore");

const initial = useUiStore.getState();

beforeEach(() => {
  writeInboxSnooze.mockReset().mockResolvedValue({});
  readInboxSnooze.mockReset().mockResolvedValue({});
  useUiStore.setState(initial, true);
});

describe("snoozeUntil", () => {
  it("is one hour later", () => {
    expect(snoozeUntil("1h", new Date(1_700_000_000_000))).toBe(1_700_000_000_000 + 3_600_000);
  });

  it("is 09:00 local tomorrow", () => {
    const now = new Date(2026, 8, 14, 18, 16, 0);
    expect(new Date(snoozeUntil("tomorrow", now))).toEqual(new Date(2026, 8, 15, 9, 0, 0, 0));
  });
});

describe("isSnoozed / pruneSnooze", () => {
  it("hides a future until and returns it once now passes", () => {
    expect(isSnoozed(100, 50)).toBe(true);
    expect(isSnoozed(100, 100)).toBe(false);
    expect(isSnoozed(undefined, 50)).toBe(false);
    expect(pruneSnooze({ live: 200, done: 50 }, 100)).toEqual({ live: 200 });
  });
});

describe("snoozeWait", () => {
  it("records the until and persists, and never answers ACP", () => {
    const until = snoozeWait("s1", "1h", new Date(1_700_000_000_000));

    expect(until).toBe(1_700_000_000_000 + 3_600_000);
    expect(useUiStore.getState().snoozedUntil).toEqual({ s1: until });
    expect(writeInboxSnooze).toHaveBeenCalledWith({ s1: until });
  });
});

describe("hydrateInboxSnooze / wakeInboxSnooze", () => {
  it("loads leftover timers and drops a missed run so the item returns", async () => {
    readInboxSnooze.mockResolvedValue({ live: Date.now() + 60_000, done: 1 });

    await hydrateInboxSnooze();

    expect(useUiStore.getState().snoozedUntil).toEqual({ live: expect.any(Number) });
    expect(writeInboxSnooze).toHaveBeenCalled();

    useUiStore.getState().setSnooze("done", 1);
    wakeInboxSnooze(2);
    expect(useUiStore.getState().snoozedUntil.done).toBeUndefined();
  });

  it("shows every wait when the file cannot be read", async () => {
    readInboxSnooze.mockRejectedValue("missing host");
    useUiStore.getState().setSnooze("s1", Date.now() + 60_000);

    await hydrateInboxSnooze();

    expect(useUiStore.getState().snoozedUntil).toEqual({});
  });
});

describe("the snooze path does not answer ACP", () => {
  it("never names answer_session_permission", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "inboxSnooze.ts"), "utf8");
    expect(src).not.toMatch(/answer_session_permission|answerSessionPermission|answerPermission/);
  });
});
