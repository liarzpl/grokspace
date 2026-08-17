import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryEntry } from "../types";

const listMemory = vi.fn();
const putMemory = vi.fn();
const removeMemory = vi.fn();
const memoryFilePath = vi.fn();
const memorySkillStatus = vi.fn();
const installMemorySkill = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      listMemory,
      putMemory,
      removeMemory,
      memoryFilePath,
      memorySkillStatus,
      installMemorySkill,
    },
  };
});

const { entriesOfType, memorySize, useMemoryStore } = await import("./memoryStore");

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    projectId: "p1",
    key: "database",
    content: "SQLite, since it ships in-process",
    type: "decision",
    updatedAt: 1000,
    ...overrides,
  };
}

const initialState = useMemoryStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useMemoryStore.setState(initialState, true);
});

describe("loadMemory", () => {
  it("takes the entries and the path the project's sessions are told to read", async () => {
    listMemory.mockResolvedValue([entry()]);
    memoryFilePath.mockResolvedValue("/p/.grokspace/memory.md");

    await useMemoryStore.getState().loadMemory("p1");

    const state = useMemoryStore.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.filePath).toBe("/p/.grokspace/memory.md");
    expect(state.isLoading).toBe(false);
  });

  it("asks for both at once, so the panel never names the last project's file", async () => {
    listMemory.mockResolvedValue([]);
    memoryFilePath.mockResolvedValue("/p2/.grokspace/memory.md");

    await useMemoryStore.getState().loadMemory("p2");

    expect(listMemory).toHaveBeenCalledWith("p2");
    expect(memoryFilePath).toHaveBeenCalledWith("p2");
  });

  it("surfaces backend errors instead of throwing", async () => {
    listMemory.mockRejectedValue("database is locked");
    memoryFilePath.mockResolvedValue("");

    await useMemoryStore.getState().loadMemory("p1");

    expect(useMemoryStore.getState().error).toBe("database is locked");
    expect(useMemoryStore.getState().isLoading).toBe(false);
  });
});

describe("putEntry", () => {
  it("takes the whole memory back, since the file is rebuilt from all of it", async () => {
    // Returning one entry would leave the panel showing something other than what
    // was written to the file agents read.
    useMemoryStore.setState({ entries: [entry()] });
    putMemory.mockResolvedValue([entry(), entry({ key: "stack", type: "context" })]);

    const ok = await useMemoryStore.getState().putEntry("p1", {
      key: "stack",
      content: "Tauri and React",
      type: "context",
    });

    expect(ok).toBe(true);
    expect(putMemory).toHaveBeenCalledWith("p1", {
      key: "stack",
      content: "Tauri and React",
      type: "context",
    });
    expect(useMemoryStore.getState().entries).toHaveLength(2);
  });

  it("reports a refused write and leaves the memory as it was", async () => {
    // The cap and the empty-key rule both land here, and both are things someone
    // needs told rather than a silently dropped note.
    useMemoryStore.setState({ entries: [entry()] });
    putMemory.mockRejectedValue("this project's memory would pass 32768 characters");

    const ok = await useMemoryStore.getState().putEntry("p1", {
      key: "huge",
      content: "x".repeat(40),
      type: "note",
    });

    expect(ok).toBe(false);
    expect(useMemoryStore.getState().entries).toHaveLength(1);
    expect(useMemoryStore.getState().error).toContain("32768");
  });
});

describe("forgetEntry", () => {
  it("takes the remaining memory from the backend", async () => {
    useMemoryStore.setState({ entries: [entry(), entry({ key: "stack" })] });
    removeMemory.mockResolvedValue([entry({ key: "stack" })]);

    await useMemoryStore.getState().forgetEntry("p1", "database");

    expect(removeMemory).toHaveBeenCalledWith("p1", "database");
    expect(useMemoryStore.getState().entries.map((e) => e.key)).toEqual(["stack"]);
  });
});

describe("the memory skill", () => {
  it("is asked about once however many times the panel mounts", async () => {
    memorySkillStatus.mockResolvedValue({ path: "/h/SKILL.md", installed: false, current: false });

    await useMemoryStore.getState().loadSkill();
    await useMemoryStore.getState().loadSkill();

    expect(memorySkillStatus).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the backend cannot answer", async () => {
    // It only decides whether to offer the install button, so a failure must not put
    // an error over a panel that is otherwise working.
    memorySkillStatus.mockRejectedValue("no home directory");

    await useMemoryStore.getState().loadSkill();

    expect(useMemoryStore.getState().skill).toBeNull();
    expect(useMemoryStore.getState().error).toBeNull();
  });

  it("leaves the button usable when the install fails", async () => {
    const before = { path: "/h/SKILL.md", installed: false, current: false };
    useMemoryStore.setState({ skill: before });
    installMemorySkill.mockRejectedValue("permission denied");

    await useMemoryStore.getState().installSkill();

    expect(useMemoryStore.getState().skill).toEqual(before);
    expect(useMemoryStore.getState().isInstallingSkill).toBe(false);
  });
});

describe("entriesOfType", () => {
  it("keeps the backend's order within a type", () => {
    const entries = [
      entry({ key: "a", type: "context" }),
      entry({ key: "b", type: "note" }),
      entry({ key: "c", type: "context" }),
    ];

    expect(entriesOfType(entries, "context").map((e) => e.key)).toEqual(["a", "c"]);
    expect(entriesOfType(entries, "artifact")).toEqual([]);
  });
});

describe("memorySize", () => {
  it("counts what every session has to read", () => {
    const entries = [entry({ content: "12345" }), entry({ key: "b", content: "123" })];

    expect(memorySize(entries)).toBe(8);
  });
});
