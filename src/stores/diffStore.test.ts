import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangedFile, DiffState } from "../types";

const projectDiff = vi.fn();
const fileDiff = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { errorMessage: actual.errorMessage, api: { projectDiff, fileDiff } };
});

const { useDiffStore } = await import("./diffStore");

const changed = (files: ChangedFile[]): DiffState => ({
  state: "changed",
  branch: "main",
  files,
  overlaps: [],
});

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
    expect(state.diff).toEqual({ state: "clean", branch: null, overlaps: [] });
    expect(state.selected).toBeNull();
    expect(state.body).toBe("");
  });

  it("does not write a body after a click during the load is cleared with the list", async () => {
    // The old rows stay on screen until the request lands. A click in that window
    // is newer than loadDiff's start generation; applying the list must also
    // invalidate it, or the body comes back with no file selected.
    useDiffStore.setState({
      diff: changed([{ path: "old.rs", change: "modified" }]),
    });
    let resolveList: (diff: DiffState) => void = () => {};
    let resolveBody: (body: string) => void = () => {};
    projectDiff.mockImplementation(
      () =>
        new Promise<DiffState>((resolve) => {
          resolveList = resolve;
        }),
    );
    fileDiff.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveBody = resolve;
        }),
    );

    const loading = useDiffStore.getState().loadDiff("p1");
    const clicked = useDiffStore.getState().selectFile("p1", {
      path: "old.rs",
      change: "modified",
    });
    resolveList(changed([{ path: "new.rs", change: "modified" }]));
    await loading;
    resolveBody("+stale");
    await clicked;

    expect(useDiffStore.getState().selected).toBeNull();
    expect(useDiffStore.getState().body).toBe("");
    expect(useDiffStore.getState().isLoadingBody).toBe(false);
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

  it("keeps the later file when two bodies complete out of order", async () => {
    let resolveFirst: (body: string) => void = () => {};
    let resolveSecond: (body: string) => void = () => {};
    fileDiff.mockImplementation((_projectId: string, path: string) => {
      if (path === "a.rs") {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new Promise<string>((resolve) => {
        resolveSecond = resolve;
      });
    });

    const first = useDiffStore.getState().selectFile("p1", { path: "a.rs", change: "modified" });
    const second = useDiffStore.getState().selectFile("p1", { path: "b.rs", change: "modified" });
    resolveSecond("+b");
    await second;
    resolveFirst("+a");
    await first;

    expect(useDiffStore.getState().selected).toBe("b.rs");
    expect(useDiffStore.getState().body).toBe("+b");
    expect(useDiffStore.getState().isLoadingBody).toBe(false);
  });

  it("does not let a stale refusal overwrite the file now on screen", async () => {
    let rejectFirst: (reason: string) => void = () => {};
    fileDiff.mockImplementation((_projectId: string, path: string) => {
      if (path === "lock.json") {
        return new Promise<string>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve("+ok");
    });

    const first = useDiffStore.getState().selectFile("p1", {
      path: "lock.json",
      change: "modified",
    });
    const second = useDiffStore.getState().selectFile("p1", {
      path: "ok.rs",
      change: "modified",
    });
    await second;
    rejectFirst("lock.json has more than 524288 bytes of diff");
    await first;

    expect(useDiffStore.getState().selected).toBe("ok.rs");
    expect(useDiffStore.getState().body).toBe("+ok");
    expect(useDiffStore.getState().error).toBeNull();
  });

  it("asks git with the scope that was on screen at the click", async () => {
    useDiffStore.setState({ scope: "agent-1" });
    let resolveBody: (body: string) => void = () => {};
    fileDiff.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveBody = resolve;
        }),
    );

    const pending = useDiffStore.getState().selectFile("p1", {
      path: "agent.rs",
      change: "untracked",
    });
    useDiffStore.setState({ scope: "agent-2" });
    resolveBody("+fn main() {}");
    await pending;

    expect(fileDiff).toHaveBeenCalledWith("p1", "agent.rs", true, "agent-1");
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

  it("lets the later list win when two complete out of order", async () => {
    let resolveFirst: (diff: DiffState) => void = () => {};
    projectDiff.mockImplementation((_projectId: string, sessionId: string | null) => {
      if (sessionId === "agent-1") {
        return new Promise<DiffState>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(changed([{ path: "b.rs", change: "modified" }]));
    });

    const first = useDiffStore.getState().loadDiff("p1", "agent-1");
    const second = useDiffStore.getState().loadDiff("p1", "agent-2");
    await second;
    resolveFirst(changed([{ path: "a.rs", change: "modified" }]));
    await first;

    const { diff, scope } = useDiffStore.getState();
    expect(scope).toBe("agent-2");
    expect(diff.state).toBe("changed");
    if (diff.state !== "changed") return;
    expect(diff.files.map((file) => file.path)).toEqual(["b.rs"]);
  });
});

describe("openPath", () => {
  it("selects a file git already reports as changed", async () => {
    projectDiff.mockResolvedValue(changed([{ path: "src/auth.rs", change: "modified" }]));
    fileDiff.mockResolvedValue("-old\n+new");

    await useDiffStore.getState().openPath("p1", "agent-1", "src/auth.rs");

    expect(projectDiff).toHaveBeenCalledWith("p1", "agent-1");
    expect(fileDiff).toHaveBeenCalledWith("p1", "src/auth.rs", false, "agent-1");
    expect(useDiffStore.getState().selected).toBe("src/auth.rs");
  });

  it("falls back to an untracked read when the path is not in the list", async () => {
    projectDiff.mockResolvedValue(changed([{ path: "other.rs", change: "modified" }]));
    fileDiff.mockResolvedValue("+fn main() {}");

    await useDiffStore.getState().openPath("p1", "agent-1", "src/auth.rs");

    expect(fileDiff).toHaveBeenCalledWith("p1", "src/auth.rs", true, "agent-1");
    expect(useDiffStore.getState().body).toContain("fn main");
  });

  it("does not open a path from a list that a newer chip has replaced", async () => {
    let resolveFirst: (diff: DiffState) => void = () => {};
    projectDiff.mockImplementation((_projectId: string, sessionId: string | null) => {
      if (sessionId === "agent-1") {
        return new Promise<DiffState>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(changed([{ path: "b.rs", change: "modified" }]));
    });
    fileDiff.mockResolvedValue("+b");

    const first = useDiffStore.getState().openPath("p1", "agent-1", "a.rs");
    const second = useDiffStore.getState().openPath("p1", "agent-2", "b.rs");
    await second;
    resolveFirst(changed([{ path: "a.rs", change: "modified" }]));
    await first;

    expect(fileDiff).toHaveBeenCalledTimes(1);
    expect(fileDiff).toHaveBeenCalledWith("p1", "b.rs", false, "agent-2");
    expect(useDiffStore.getState().selected).toBe("b.rs");
    expect(useDiffStore.getState().body).toBe("+b");
  });

  it("drops a file body that a later list load has already replaced", async () => {
    projectDiff.mockResolvedValue(changed([{ path: "a.rs", change: "modified" }]));
    let resolveBody: (body: string) => void = () => {};
    fileDiff.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveBody = resolve;
        }),
    );

    const pending = useDiffStore.getState().selectFile("p1", {
      path: "a.rs",
      change: "modified",
    });
    projectDiff.mockResolvedValue({ state: "clean", branch: "main", overlaps: [] });
    await useDiffStore.getState().loadDiff("p1", "agent-2");
    resolveBody("+stale");
    await pending;

    expect(useDiffStore.getState().selected).toBeNull();
    expect(useDiffStore.getState().body).toBe("");
    expect(useDiffStore.getState().isLoadingBody).toBe(false);
    expect(useDiffStore.getState().scope).toBe("agent-2");
  });

  it("reads an unlisted path against the session that asked, not a later chip", async () => {
    projectDiff.mockResolvedValue(changed([{ path: "other.rs", change: "modified" }]));
    let resolveBody: (body: string) => void = () => {};
    fileDiff.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveBody = resolve;
        }),
    );

    const pending = useDiffStore.getState().openPath("p1", "agent-1", "src/auth.rs");
    await vi.waitFor(() => expect(fileDiff).toHaveBeenCalled());
    expect(fileDiff).toHaveBeenCalledWith("p1", "src/auth.rs", true, "agent-1");

    projectDiff.mockResolvedValue({ state: "clean", branch: "main", overlaps: [] });
    await useDiffStore.getState().loadDiff("p1", "agent-2");
    resolveBody("+stale");
    await pending;

    expect(useDiffStore.getState().selected).toBeNull();
    expect(useDiffStore.getState().body).toBe("");
    expect(useDiffStore.getState().scope).toBe("agent-2");
  });

  it("does not open its path if a file was clicked while the list was loading", async () => {
    useDiffStore.setState({
      diff: changed([{ path: "old.rs", change: "modified" }]),
    });
    let resolveList: (diff: DiffState) => void = () => {};
    projectDiff.mockImplementation(
      () =>
        new Promise<DiffState>((resolve) => {
          resolveList = resolve;
        }),
    );
    fileDiff.mockResolvedValue("+clicked");

    const opening = useDiffStore.getState().openPath("p1", "agent-1", "target.rs");
    const clicked = useDiffStore.getState().selectFile("p1", {
      path: "old.rs",
      change: "modified",
    });
    resolveList(
      changed([
        { path: "target.rs", change: "modified" },
        { path: "old.rs", change: "modified" },
      ]),
    );
    await opening;
    await clicked;

    expect(fileDiff).not.toHaveBeenCalledWith("p1", "target.rs", false, "agent-1");
    expect(useDiffStore.getState().selected).toBeNull();
    expect(useDiffStore.getState().body).toBe("");
  });
});

describe("overlaps", () => {
  it("keeps the overlap list the backend reports", async () => {
    projectDiff.mockResolvedValue({
      state: "changed",
      branch: "grokspace/aaaaaaaa",
      files: [{ path: "agent.rs", change: "untracked" }],
      overlaps: [
        {
          path: "agent.rs",
          hotspot: false,
          peers: [{ sessionId: "agent-2", title: "Reviewer" }],
        },
      ],
    });

    await useDiffStore.getState().loadDiff("p1", "agent-1");

    const { diff } = useDiffStore.getState();
    expect(diff.state).toBe("changed");
    if (diff.state !== "changed") return;
    expect(diff.overlaps).toEqual([
      {
        path: "agent.rs",
        hotspot: false,
        peers: [{ sessionId: "agent-2", title: "Reviewer" }],
      },
    ]);
  });
});
