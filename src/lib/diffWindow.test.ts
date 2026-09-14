import { describe, expect, it } from "vitest";

import {
  INITIAL_DIFF_LINES,
  MORE_DIFF_LINES,
  growVisible,
  lineCount,
  windowHunks,
  windowLines,
} from "./diffWindow";

describe("windowLines", () => {
  it("returns the whole text when it fits", () => {
    expect(windowLines("a\nb\nc", 10)).toEqual({ text: "a\nb\nc", hidden: 0 });
  });

  it("keeps the first N lines and reports the rest", () => {
    expect(windowLines("a\nb\nc\nd", 2)).toEqual({ text: "a\nb", hidden: 2 });
  });
});

describe("windowHunks", () => {
  it("shows whole hunks until the line budget is spent", () => {
    const windowed = windowHunks("head\nhead", ["@@ 1\n+a", "@@ 2\n+b\n+c"], 4);

    expect(windowed.prelude).toBe("head\nhead");
    expect(windowed.hunks).toEqual(["@@ 1\n+a"]);
    expect(windowed.hidden).toBe(3);
  });

  it("clips a prelude that already fills the budget", () => {
    const windowed = windowHunks("a\nb\nc", ["@@ 1\n+x"], 2);

    expect(windowed.prelude).toBe("a\nb");
    expect(windowed.hunks).toEqual([]);
    expect(windowed.hidden).toBe(3);
  });
});

describe("growVisible", () => {
  it("adds a page without passing the total", () => {
    expect(growVisible(INITIAL_DIFF_LINES, INITIAL_DIFF_LINES + 10)).toBe(
      INITIAL_DIFF_LINES + 10,
    );
    expect(growVisible(10, 10_000)).toBe(10 + MORE_DIFF_LINES);
  });
});

describe("lineCount", () => {
  it("counts empty as zero so a missing prelude does not spend the budget", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\nb")).toBe(2);
  });
});
