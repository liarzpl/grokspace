import { describe, expect, it } from "vitest";

import { errorMessage, taskDescriptionPatch } from "./api";

describe("errorMessage", () => {
  it("returns a Rust invoke rejection as-is", () => {
    expect(errorMessage("no session found with id x")).toBe("no session found with id x");
  });

  it("unwraps a thrown Error", () => {
    expect(errorMessage(new Error("that session is no longer running"))).toBe(
      "that session is no longer running",
    );
  });

  it("falls back when the rejection is wrapped, not a string", () => {
    // A Serialize-as-object change would land here. String(object) is [object Object].
    expect(errorMessage({ message: "no session found with id x" })).toBe("Something went wrong.");
  });
});

describe("taskDescriptionPatch", () => {
  it("sends null when the field is omitted, so the column is left alone", () => {
    expect(taskDescriptionPatch(undefined)).toBeNull();
  });

  it("keeps the empty-string sentinel so a clear can write SQL NULL", () => {
    expect(taskDescriptionPatch("")).toBe("");
  });

  it("passes through a typed description", () => {
    expect(taskDescriptionPatch("Why it matters")).toBe("Why it matters");
  });
});
