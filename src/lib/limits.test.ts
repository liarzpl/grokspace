import { describe, expect, it } from "vitest";

import { FALLBACK_PTY_SIZE, MAX_MEMORY_CHARS, MAX_STEPS } from "./limits";

describe("shared limits", () => {
  it("names the classic PTY size every spawn path should use", () => {
    expect(FALLBACK_PTY_SIZE).toEqual({ cols: 80, rows: 24 });
  });

  it("matches the backend memory and step caps", () => {
    expect(MAX_MEMORY_CHARS).toBe(32 * 1024);
    expect(MAX_STEPS).toBe(20);
  });
});
