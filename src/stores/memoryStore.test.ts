import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MemoryEntry } from "../types";

const listMemory = vi.fn();
const putMemory = vi.fn();
const removeMemory = vi.fn();
const memoryFilePath = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      listMemory,
      putMemory,
      removeMemory,
      memoryFilePath,
    },
  };
});

const { entriesForProject, entriesOfType, memoryFilePathFor, memorySize, useMemoryStore } =
  await import("./memoryStore");

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

  it("empties the previous project's memory when the load fails", async () => {
    useMemoryStore.setState({
      entries: [entry()],
      filePath: "/p1/.grokspace/memory.md",
    });
    listMemory.mockRejectedValue("database is locked");
    memoryFilePath.mockResolvedValue("");

    await useMemoryStore.getState().loadMemory("p2");

    const state = useMemoryStore.getState();
    expect(state.entries).toEqual([]);
    expect(state.filePath).toBe("");
  });

  it("clears leftover entries even when no project has been recorded yet", async () => {
    useMemoryStore.setState({
      entries: [entry()],
      filePath: "/p1/.grokspace/memory.md",
    });
    let resolveEntries: (entries: MemoryEntry[]) => void = () => {};
    listMemory.mockImplementation(
      () =>
        new Promise<MemoryEntry[]>((resolve) => {
          resolveEntries = resolve;
        }),
    );
    memoryFilePath.mockResolvedValue("/p2/.grokspace/memory.md");

    const pending = useMemoryStore.getState().loadMemory("p2");

    expect(useMemoryStore.getState().entries).toEqual([]);
    expect(useMemoryStore.getState().filePath).toBe("");

    resolveEntries([]);
    await pending;
  });

  it("empties the previous project's memory before the next list arrives", async () => {
    useMemoryStore.setState({
      entries: [entry()],
      projectId: "p1",
      filePath: "/p1/.grokspace/memory.md",
    });
    let resolveEntries: (entries: MemoryEntry[]) => void = () => {};
    listMemory.mockImplementation(
      () =>
        new Promise<MemoryEntry[]>((resolve) => {
          resolveEntries = resolve;
        }),
    );
    memoryFilePath.mockResolvedValue("/p2/.grokspace/memory.md");

    const pending = useMemoryStore.getState().loadMemory("p2");

    expect(useMemoryStore.getState().entries).toEqual([]);
    expect(useMemoryStore.getState().filePath).toBe("");
    expect(useMemoryStore.getState().projectId).toBe("p2");

    resolveEntries([entry({ projectId: "p2", key: "api" })]);
    await pending;

    expect(useMemoryStore.getState().entries.map((item) => item.key)).toEqual(["api"]);
    expect(useMemoryStore.getState().filePath).toBe("/p2/.grokspace/memory.md");
  });

  it("does not blank the current project's memory while re-reading it", async () => {
    useMemoryStore.setState({
      entries: [entry()],
      projectId: "p1",
      filePath: "/p1/.grokspace/memory.md",
    });
    let resolveEntries: (entries: MemoryEntry[]) => void = () => {};
    listMemory.mockImplementation(
      () =>
        new Promise<MemoryEntry[]>((resolve) => {
          resolveEntries = resolve;
        }),
    );
    memoryFilePath.mockResolvedValue("/p1/.grokspace/memory.md");

    const pending = useMemoryStore.getState().loadMemory("p1");

    expect(useMemoryStore.getState().entries).toHaveLength(1);
    expect(useMemoryStore.getState().filePath).toBe("/p1/.grokspace/memory.md");

    resolveEntries([entry()]);
    await pending;
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

  it("drops a write that returns after the project has changed", async () => {
    useMemoryStore.setState({ entries: [entry()], projectId: "p1" });
    let resolvePut: (entries: MemoryEntry[]) => void = () => {};
    putMemory.mockImplementation(
      () =>
        new Promise<MemoryEntry[]>((resolve) => {
          resolvePut = resolve;
        }),
    );

    const pending = useMemoryStore.getState().putEntry("p1", {
      key: "stack",
      content: "Tauri and React",
      type: "context",
    });
    useMemoryStore.setState({
      projectId: "p2",
      entries: [entry({ projectId: "p2", key: "api" })],
    });
    resolvePut([entry(), entry({ key: "stack", type: "context" })]);
    const ok = await pending;

    expect(ok).toBe(false);
    expect(useMemoryStore.getState().entries.map((item) => item.key)).toEqual(["api"]);
  });

  it("does not surface a refused write after the project has changed", async () => {
    useMemoryStore.setState({ projectId: "p1" });
    let rejectPut: (reason: unknown) => void = () => {};
    putMemory.mockImplementation(
      () =>
        new Promise<MemoryEntry[]>((_, reject) => {
          rejectPut = reject;
        }),
    );

    const pending = useMemoryStore.getState().putEntry("p1", {
      key: "stack",
      content: "Tauri and React",
      type: "context",
    });
    useMemoryStore.setState({ projectId: "p2" });
    rejectPut("this project's memory would pass 32768 characters");
    const ok = await pending;

    expect(ok).toBe(false);
    expect(useMemoryStore.getState().error).toBeNull();
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

  it("drops a forget that returns after the project has changed", async () => {
    useMemoryStore.setState({ entries: [entry()], projectId: "p1" });
    let resolveForget: (entries: MemoryEntry[]) => void = () => {};
    removeMemory.mockImplementation(
      () =>
        new Promise<MemoryEntry[]>((resolve) => {
          resolveForget = resolve;
        }),
    );

    const pending = useMemoryStore.getState().forgetEntry("p1", "database");
    useMemoryStore.setState({
      projectId: "p2",
      entries: [entry({ projectId: "p2", key: "api" })],
    });
    resolveForget([]);
    await pending;

    expect(useMemoryStore.getState().entries.map((item) => item.key)).toEqual(["api"]);
  });

  it("does not surface a refused forget after the project has changed", async () => {
    useMemoryStore.setState({ projectId: "p1" });
    let rejectForget: (reason: unknown) => void = () => {};
    removeMemory.mockImplementation(
      () =>
        new Promise<MemoryEntry[]>((_, reject) => {
          rejectForget = reject;
        }),
    );

    const pending = useMemoryStore.getState().forgetEntry("p1", "database");
    useMemoryStore.setState({ projectId: "p2" });
    rejectForget("database is locked");
    await pending;

    expect(useMemoryStore.getState().error).toBeNull();
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

describe("entriesForProject", () => {
  it("hides another project's entries from the panel and the header tally", () => {
    const entries = [entry(), entry({ projectId: "p2", key: "api" })];

    expect(entriesForProject(entries, "p1").map((item) => item.key)).toEqual(["database"]);
    expect(entriesForProject(entries, "p2").map((item) => item.key)).toEqual(["api"]);
    expect(entriesForProject(entries, "p2")).toHaveLength(1);
  });
});

describe("memoryFilePathFor", () => {
  it("hides the last project's path until this one is loaded", () => {
    expect(memoryFilePathFor("/p1/.grokspace/memory.md", "p1", "p2")).toBe("");
    expect(memoryFilePathFor("/p1/.grokspace/memory.md", null, "p2")).toBe("");
    expect(memoryFilePathFor("/p2/.grokspace/memory.md", "p2", "p2")).toBe(
      "/p2/.grokspace/memory.md",
    );
  });
});

describe("memorySize", () => {
  it("counts what every session has to read", () => {
    const entries = [entry({ content: "12345" }), entry({ key: "b", content: "123" })];

    expect(memorySize(entries)).toBe(8);
  });
});
