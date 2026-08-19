import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangedFile, DiffState } from "../types";

const projectDiff = vi.fn();
const fileDiff = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { errorMessage: actual.errorMessage, api: { projectDiff, fileDiff } };
});

const { changedCount, useDiffStore } = await import("./diffStore");

const changed = (files: ChangedFile[]): DiffState => ({ state: "changed", branch: "main", files });

const initialState = useDiffStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useDiffStore.setState(initialState, true);
});

describe("loadDiff", () => {
  it("takes whichever of the four states the backend reports", async () => {
    projectDiff.mockResolvedValue({ state: "gitMissing" });

    await useDiffStore.getState().loadDiff("p1");

    expect(useDiffStore.getState().diff).toEqual({ state: "gitMissing" });
    expect(useDiffStore.getState().isLoading).toBe(false);
  });

  it("drops the open file, since a refresh can find it committed", async () => {
    // A body left on screen would describe a change that no longer exists.
    useDiffStore.setState({ selected: "README.md", body: "-old\n+new" });
    projectDiff.mockResolvedValue(changed([{ path: "other.rs", change: "modified" }]));

    await useDiffStore.getState().loadDiff("p1");

    expect(useDiffStore.getState().selected).toBeNull();
    expect(useDiffStore.getState().body).toBe("");
  });

  it("surfaces a failure instead of throwing", async () => {
    projectDiff.mockRejectedValue("no project found with id p1");

    await useDiffStore.getState().loadDiff("p1");

    expect(useDiffStore.getState().error).toBe("no project found with id p1");
    expect(useDiffStore.getState().isLoading).toBe(false);
  });

  it("drops the previous project's diff when the load fails", async () => {
    useDiffStore.setState({
      diff: changed([{ path: "old.rs", change: "modified" }]),
      selected: "old.rs",
      body: "-a\n+b",
    });
    projectDiff.mockRejectedValue("no project found with id p2");

    await useDiffStore.getState().loadDiff("p2");

    const state = useDiffStore.getState();
    expect(state.diff).toEqual({ state: "clean", branch: null });
    expect(state.selected).toBeNull();
    expect(state.body).toBe("");
  });
});

describe("selectFile", () => {
  it("asks for a tracked file's diff against HEAD", async () => {
    fileDiff.mockResolvedValue("-hello\n+goodbye");

    await useDiffStore.getState().selectFile("p1", { path: "README.md", change: "modified" });

    expect(fileDiff).toHaveBeenCalledWith("p1", "README.md", false, null);
    expect(useDiffStore.getState().body).toContain("+goodbye");
  });

  it("asks for an untracked file to be diffed against nothing", async () => {
    // There is nothing in HEAD to compare with, so every line reads as an addition -
    // which is what someone looking at a file an agent just wrote wants.
    fileDiff.mockResolvedValue("+fn main() {}");

    await useDiffStore.getState().selectFile("p1", { path: "new.rs", change: "untracked" });

    expect(fileDiff).toHaveBeenCalledWith("p1", "new.rs", true, null);
  });

  it("keeps the file selected when its diff is refused", async () => {
    // The size ceiling lands here, and the reason is worth reading beside the file it
    // is about rather than after the selection has been thrown away.
    fileDiff.mockRejectedValue("lock.json has more than 524288 bytes of diff");

    await useDiffStore.getState().selectFile("p1", { path: "lock.json", change: "modified" });

    expect(useDiffStore.getState().selected).toBe("lock.json");
    expect(useDiffStore.getState().error).toContain("524288");
    expect(useDiffStore.getState().isLoadingBody).toBe(false);
  });
});

describe("scope", () => {
  it("passes the session id through to both reads", async () => {
    projectDiff.mockResolvedValue({ state: "clean", branch: "grokspace/aaaaaaaa" });
    fileDiff.mockResolvedValue("+fn main() {}");

    await useDiffStore.getState().loadDiff("p1", "agent-1");

    expect(projectDiff).toHaveBeenCalledWith("p1", "agent-1");
    expect(useDiffStore.getState().scope).toBe("agent-1");

    await useDiffStore.getState().selectFile("p1", { path: "agent.rs", change: "untracked" });

    expect(fileDiff).toHaveBeenCalledWith("p1", "agent.rs", true, "agent-1");
  });

  it("drops a previous scope when loading the project tree", async () => {
    useDiffStore.setState({ scope: "agent-1" });
    projectDiff.mockResolvedValue({ state: "clean", branch: "main" });

    await useDiffStore.getState().loadDiff("p1");

    expect(projectDiff).toHaveBeenCalledWith("p1", null);
    expect(useDiffStore.getState().scope).toBeNull();
  });
});

describe("changedCount", () => {
  it("counts only in the state that has files", () => {
    expect(changedCount(changed([{ path: "a", change: "modified" }]))).toBe(1);
    expect(changedCount({ state: "clean", branch: "main" })).toBe(0);
    expect(changedCount({ state: "gitMissing" })).toBe(0);
    expect(changedCount({ state: "notARepo" })).toBe(0);
  });
});
