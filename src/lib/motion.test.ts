import { describe, expect, it } from "vitest";

import { prefersReducedMotion } from "./motion";

describe("prefersReducedMotion", () => {
  it("is true only when the media query matches", () => {
    expect(prefersReducedMotion({ matches: true })).toBe(true);
    expect(prefersReducedMotion({ matches: false })).toBe(false);
  });

  it("is false when matchMedia is missing, so a node test does not invent motion", () => {
    expect(prefersReducedMotion(null)).toBe(false);
  });
});
