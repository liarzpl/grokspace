import { describe, expect, it } from "vitest";

import {
  capHandoffTranscript,
  formatTranscriptMd,
  HANDOFF_LEDGER_FILE,
  HANDOFF_PACK_FILES,
  HANDOFF_TRANSCRIPT_CHARS,
  isHandoffSecretPath,
} from "./handoffPack";

describe("the handoff pack listing", () => {
  it("names the files a zip or folder must hold, and omits secrets", () => {
    expect([...HANDOFF_PACK_FILES]).toEqual([
      "graph.json",
      "steps.json",
      "memory.md",
      "transcript.md",
      "changes.patch",
    ]);
    expect(HANDOFF_PACK_FILES).not.toContain(".env");
    expect(HANDOFF_LEDGER_FILE).toBe("ledger-tail.jsonl");
    expect(isHandoffSecretPath(".env")).toBe(true);
    expect(isHandoffSecretPath("apps/.env.local")).toBe(true);
    expect(isHandoffSecretPath(".grokspace/worktreeinclude")).toBe(true);
    expect(isHandoffSecretPath("src/main.rs")).toBe(false);
  });
});

describe("the transcript cap", () => {
  it("keeps the tail once the pack budget is exceeded", () => {
    const text = `${"a".repeat(HANDOFF_TRANSCRIPT_CHARS)}TAIL`;
    const capped = capHandoffTranscript(text);
    expect(capped.endsWith("TAIL")).toBe(true);
    expect(Array.from(capped)).toHaveLength(HANDOFF_TRANSCRIPT_CHARS);
    expect(formatTranscriptMd([{ kind: "message", text: "hello" }])).toBe("## message\n\nhello\n");
  });
});
