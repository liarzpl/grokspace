import { describe, expect, it } from "vitest";

import {
  foldUpdate,
  growTranscriptWindow,
  MORE_TRANSCRIPT_ROWS,
  transcriptRowKey,
  TRANSCRIPT_CAP,
  TRANSCRIPT_WINDOW,
  windowTranscript,
} from "./transcript";
import type { AgentUpdate } from "../types";

function update(kind: AgentUpdate["kind"], text: string): AgentUpdate {
  return { kind, text };
}

describe("foldUpdate", () => {
  it("concatenates consecutive message chunks", () => {
    const folded = foldUpdate([update("message", "Hel")], update("message", "lo"));
    expect(folded).toEqual([update("message", "Hello")]);
  });

  it("concatenates consecutive thought chunks, but not a thought onto a message", () => {
    const thoughts = foldUpdate([update("thought", "hmm")], update("thought", "…"));
    expect(thoughts).toEqual([update("thought", "hmm…")]);

    const mixed = foldUpdate([update("message", "Hi")], update("thought", "aside"));
    expect(mixed).toEqual([update("message", "Hi"), update("thought", "aside")]);
  });

  it("replaces a plan with the next one rather than stacking them", () => {
    const folded = foldUpdate(
      [update("plan", "pending find it")],
      update("plan", "completed find it\npending write it"),
    );
    expect(folded).toEqual([update("plan", "completed find it\npending write it")]);
  });

  it("keeps tool calls and prompts as separate lines", () => {
    const folded = foldUpdate(
      [update("tool", "Read src/lib.rs"), update("prompt", "What leaked?")],
      update("tool", "Read src/lib.rs · completed"),
    );
    expect(folded).toHaveLength(3);
    expect(folded[2]?.text).toContain("completed");
  });

  it("drops the oldest entries once the cap is reached", () => {
    const many = Array.from({ length: TRANSCRIPT_CAP }, (_, index) =>
      update("tool", `call ${index}`),
    );
    const folded = foldUpdate(many, update("tool", "call last"));
    expect(folded).toHaveLength(TRANSCRIPT_CAP);
    expect(folded[0]?.text).toBe("call 1");
    expect(folded[folded.length - 1]?.text).toBe("call last");
  });
});

describe("windowTranscript", () => {
  it("returns the whole list when it fits", () => {
    const entries = [update("tool", "a"), update("tool", "b")];
    expect(windowTranscript(entries, 10)).toEqual({ shown: entries, offset: 0, hidden: 0 });
  });

  it("keeps the newest N rows and reports the rest", () => {
    const entries = [update("tool", "a"), update("tool", "b"), update("tool", "c"), update("tool", "d")];
    expect(windowTranscript(entries, 2)).toEqual({
      shown: [update("tool", "c"), update("tool", "d")],
      offset: 2,
      hidden: 2,
    });
  });

  it("unmounts everything when the limit is not positive", () => {
    const entries = [update("message", "hi")];
    expect(windowTranscript(entries, 0)).toEqual({ shown: [], offset: 1, hidden: 1 });
  });
});

describe("growTranscriptWindow", () => {
  it("adds a page without passing the total", () => {
    expect(growTranscriptWindow(TRANSCRIPT_WINDOW, TRANSCRIPT_WINDOW + 10)).toBe(
      TRANSCRIPT_WINDOW + 10,
    );
    expect(growTranscriptWindow(10, 10_000)).toBe(10 + MORE_TRANSCRIPT_ROWS);
  });
});

describe("transcriptRowKey", () => {
  it("names a folded row by its store index, not the window offset", () => {
    expect(transcriptRowKey(12, "message")).toBe("12:message");
  });
});
