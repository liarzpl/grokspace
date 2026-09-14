import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOOM_LOOP_THRESHOLD,
  doomLoopNotice,
  doomLoopTripped,
  noteToolRepeat,
  type ToolRepeat,
} from "./doomLoop";

function streak(texts: string[]): ToolRepeat | undefined {
  return texts.reduce<ToolRepeat | undefined>(
    (previous, text) => noteToolRepeat(previous, text),
    undefined,
  );
}

describe("doomLoop", () => {
  it("trips after three identical tool texts when the threshold is 3", () => {
    const two = streak(["Read src/lib.rs", "Read src/lib.rs"]);
    expect(doomLoopTripped(two, 3)).toBe(false);

    const three = streak(["Read src/lib.rs", "Read src/lib.rs", "Read src/lib.rs"]);
    expect(doomLoopTripped(three, 3)).toBe(true);
    expect(three?.count).toBe(3);
  });

  it("does not trip when args differ", () => {
    const repeat = streak([
      'Read · {"path":"src/lib.rs"}',
      'Read · {"path":"src/lib.rs"}',
      'Read · {"path":"src/main.rs"}',
    ]);
    expect(doomLoopTripped(repeat, 3)).toBe(false);
    expect(repeat).toEqual({ text: 'Read · {"path":"src/main.rs"}', count: 1 });
  });

  it("defaults to five so four identical tools stay quiet", () => {
    expect(DEFAULT_DOOM_LOOP_THRESHOLD).toBe(5);
    const four = streak(Array.from({ length: 4 }, () => "Bash · npm test"));
    expect(doomLoopTripped(four)).toBe(false);
    const five = streak(Array.from({ length: 5 }, () => "Bash · npm test"));
    expect(doomLoopTripped(five)).toBe(true);
  });

  it("names the session and the repeated text", () => {
    expect(doomLoopNotice("Coder", { text: "Read src/lib.rs", count: 5 })).toBe(
      "Coder · same tool 5 times: Read src/lib.rs",
    );
    expect(doomLoopNotice("  ", { text: "Read", count: 5 })).toBe(
      "Agent · same tool 5 times: Read",
    );
  });
});
