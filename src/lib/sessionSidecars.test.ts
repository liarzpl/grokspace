import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scheduleIdle,
  sessionIdKey,
  sessionIdsFromKey,
  sidecarLoadPlan,
} from "./sessionSidecars";

describe("sessionIdKey", () => {
  it("round-trips ids that would split on a space", () => {
    const ids = ["alpha", "beta gamma"];
    expect(sessionIdsFromKey(sessionIdKey(ids))).toEqual(ids);
  });

  it("treats an empty key as no sessions", () => {
    expect(sessionIdKey([])).toBe("");
    expect(sessionIdsFromKey("")).toEqual([]);
  });
});

describe("sidecarLoadPlan", () => {
  const sessionIds = ["pane-0", "pane-1", "agent"];
  const paneSessionIds = ["pane-0", "pane-1"];

  it("loads pane sessions first on Terminals, and defers pane-less agents", () => {
    expect(
      sidecarLoadPlan({
        sessionIds,
        paneSessionIds,
        tab: "terminals",
        selectedGraphId: "agent",
      }),
    ).toEqual({
      immediate: ["pane-0", "pane-1"],
      deferred: ["agent"],
    });
  });

  it("loads the selected graph session first, and defers the rest", () => {
    expect(
      sidecarLoadPlan({
        sessionIds,
        paneSessionIds,
        tab: "graph",
        selectedGraphId: "agent",
      }),
    ).toEqual({
      immediate: ["agent"],
      deferred: ["pane-0", "pane-1"],
    });
  });

  it("falls back to the first session when the graph selection has gone", () => {
    expect(
      sidecarLoadPlan({
        sessionIds,
        paneSessionIds,
        tab: "graph",
        selectedGraphId: "gone",
      }),
    ).toEqual({
      immediate: ["pane-0"],
      deferred: ["pane-1", "agent"],
    });
  });

  it("defers every session on a tab that does not show those dots", () => {
    expect(
      sidecarLoadPlan({
        sessionIds,
        paneSessionIds,
        tab: "tasks",
        selectedGraphId: "pane-0",
      }),
    ).toEqual({
      immediate: [],
      deferred: sessionIds,
    });
  });
});

describe("scheduleIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runs the work after a turn, and cancel skips it", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.useFakeTimers();
    const work = vi.fn();

    const cancel = scheduleIdle(work);
    expect(work).not.toHaveBeenCalled();
    cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(work).not.toHaveBeenCalled();

    scheduleIdle(work);
    await vi.advanceTimersByTimeAsync(0);
    expect(work).toHaveBeenCalledOnce();
  });
});
