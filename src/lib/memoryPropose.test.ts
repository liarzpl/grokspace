import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_MEMORY_CHARS } from "./limits";
import {
  DEFAULT_MEMORY_PROPOSE_TYPE,
  draftFromTranscriptText,
  MEMORY_PROPOSE_TYPES,
  memoryWouldExceedCap,
  namedMemoryKey,
  offersMemoryChip,
} from "./memoryPropose";
import type { MemoryEntry } from "../types";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    projectId: "p1",
    key: "database",
    content: "SQLite",
    type: "note",
    updatedAt: 1000,
    ...overrides,
  };
}

describe("memoryPropose", () => {
  it("reads Memory key lines and a few named-key phrases", () => {
    expect(namedMemoryKey("SQLite stays.\nMemory key: `database`")).toBe("database");
    expect(namedMemoryKey("memory key: stack")).toBe("stack");
    expect(namedMemoryKey("This belongs under the key `auth-model`.")).toBe("auth-model");
    expect(namedMemoryKey("I named the key `ports`.")).toBe("ports");
  });

  it("ignores ordinary prose, JSON keys, and stray backticks", () => {
    expect(namedMemoryKey("Use the key in the map.")).toBeNull();
    expect(namedMemoryKey('{ "key": "value" }')).toBeNull();
    expect(namedMemoryKey("See `src/lib.rs`.")).toBeNull();
  });

  it("prefills the named key and the rest of the reply", () => {
    expect(draftFromTranscriptText("SQLite stays in-process.\nMemory key: `database`")).toEqual({
      key: "database",
      content: "SQLite stays in-process.",
    });
    expect(draftFromTranscriptText("Just a thought.")).toEqual({
      key: "",
      content: "Just a thought.",
    });
  });

  it("offers a named-key message or the last non-empty line", () => {
    expect(offersMemoryChip({ kind: "message", text: "Memory key: `database`" }, false)).toBe(true);
    expect(offersMemoryChip({ kind: "message", text: "hello" }, false)).toBe(false);
    expect(offersMemoryChip({ kind: "thought", text: "aside" }, true)).toBe(true);
    expect(offersMemoryChip({ kind: "message", text: "   " }, true)).toBe(false);
  });

  it("refuses a write that would pass the cap, replacing the same key's size", () => {
    const filled = entry({ content: "x".repeat(MAX_MEMORY_CHARS - 4) });
    expect(memoryWouldExceedCap([filled], "new", "12345")).toBe(true);
    expect(memoryWouldExceedCap([filled], "new", "1234")).toBe(false);

    const rows = [
      entry({ key: "big", content: "x".repeat(MAX_MEMORY_CHARS - 10) }),
      entry({ key: "database", content: "old".repeat(20) }),
    ];
    expect(memoryWouldExceedCap(rows, "database", "short")).toBe(false);
    expect(memoryWouldExceedCap(rows, "database", "y".repeat(20))).toBe(true);
  });

  it("defaults to note and keeps the skill's Memory key line", () => {
    expect(DEFAULT_MEMORY_PROPOSE_TYPE).toBe("note");
    expect(MEMORY_PROPOSE_TYPES).toEqual(["note", "context", "decision"]);
    const skill = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/skills/project-memory/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("Memory key:");
    expect(skill).toContain("Do not write to it");
    expect(skill).toContain("Add to Memory");
  });
});
