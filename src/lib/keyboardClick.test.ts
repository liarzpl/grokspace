import { describe, expect, it } from "vitest";

import { isKeyboardClick } from "./keyboardClick";

describe("isKeyboardClick", () => {
  it("treats detail 0 as a keyboard activation", () => {
    expect(isKeyboardClick({ detail: 0 })).toBe(true);
  });

  it("treats a pointer click and a double-click as not keyboard", () => {
    expect(isKeyboardClick({ detail: 1 })).toBe(false);
    expect(isKeyboardClick({ detail: 2 })).toBe(false);
  });
});
