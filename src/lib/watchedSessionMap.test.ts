import { afterEach, describe, expect, it, vi } from "vitest";

import { COALESCE_MS, createWatchedSessionMap } from "./watchedSessionMap";

afterEach(() => {
  vi.useRealTimers();
});

describe("createWatchedSessionMap", () => {
  it("coalesces a burst into one load", () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const watch = createWatchedSessionMap({ onClosed: "keep-if-present" });
    const handlers = { hasEntry: () => false, load, forget: vi.fn() };

    watch.refresh("s1", true, handlers);
    watch.refresh("s1", true, handlers);
    watch.refresh("s1", true, handlers);
    vi.advanceTimersByTime(COALESCE_MS - 1);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps a held graph when the session is no longer open", () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const forget = vi.fn();
    const watch = createWatchedSessionMap({ onClosed: "keep-if-present" });

    watch.refresh("s1", false, { hasEntry: () => true, load, forget });
    vi.advanceTimersByTime(COALESCE_MS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(forget).not.toHaveBeenCalled();
  });

  it("ignores a closed session it has never held", () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const watch = createWatchedSessionMap({ onClosed: "keep-if-present" });

    watch.refresh("closed", false, { hasEntry: () => false, load, forget: vi.fn() });
    vi.advanceTimersByTime(COALESCE_MS);
    expect(load).not.toHaveBeenCalled();
  });

  it("forgets a closed session when that is the policy", () => {
    const forget = vi.fn();
    const watch = createWatchedSessionMap({ onClosed: "forget" });

    watch.refresh("s1", false, { hasEntry: () => true, load: vi.fn(), forget });
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("cancel drops a queued load", () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const watch = createWatchedSessionMap({ onClosed: "keep-if-present" });

    watch.refresh("s1", true, { hasEntry: () => false, load, forget: vi.fn() });
    watch.cancel("s1");
    vi.advanceTimersByTime(COALESCE_MS);
    expect(load).not.toHaveBeenCalled();
  });
});
