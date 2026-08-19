import { describe, expect, it } from "vitest";

import { foldUpdate, TRANSCRIPT_CAP } from "./transcript";
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
