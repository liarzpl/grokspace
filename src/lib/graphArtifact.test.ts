import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangedFile, DiffState } from "../types";

const projectDiff = vi.fn();
const fileDiff = vi.fn();
const revealArtifact = vi.fn();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { errorMessage: actual.errorMessage, api: { projectDiff, fileDiff, revealArtifact } };
});

const {
  artifactPreviewKind,
  claimedArtifactPaths,
  claimedPathsFromMemory,
  isFileArtifact,
  openArtifactInDiff,
  openArtifactInFinder,
  uniqueFileArtifacts,
} = await import("./graphArtifact");
const { useDiffStore } = await import("../stores/diffStore");
const { useUiStore } = await import("../stores/uiStore");

const changed = (files: ChangedFile[]): DiffState => ({
  state: "changed",
  branch: "grokspace/aaaaaaaa",
  files,
});

const diffInitial = useDiffStore.getState();
const uiInitial = useUiStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useDiffStore.setState(diffInitial, true);
  useUiStore.setState(uiInitial, true);
});

describe("isFileArtifact", () => {
  it("accepts a relative file path", () => {
    expect(isFileArtifact("src/auth.rs")).toBe(true);
  });

  it("refuses a directory written with a trailing slash", () => {
    expect(isFileArtifact(".grokspace/graphs/artifacts/drafts/")).toBe(false);
  });

  it("refuses empty and missing paths", () => {
    expect(isFileArtifact(undefined)).toBe(false);
    expect(isFileArtifact("")).toBe(false);
    expect(isFileArtifact("   ")).toBe(false);
  });
});

describe("openArtifactInDiff", () => {
  it("switches to the Diff tab and selects a changed file", async () => {
    projectDiff.mockResolvedValue(
      changed([{ path: "src/auth.rs", change: "modified" }]),
    );
    fileDiff.mockResolvedValue("-old\n+new");

    await openArtifactInDiff("p1", "agent-1", "src/auth.rs");

    expect(useUiStore.getState().tab).toBe("diff");
    expect(projectDiff).toHaveBeenCalledWith("p1", "agent-1");
    expect(fileDiff).toHaveBeenCalledWith("p1", "src/auth.rs", false, "agent-1");
    expect(useDiffStore.getState().selected).toBe("src/auth.rs");
    expect(useDiffStore.getState().body).toContain("+new");
  });

  it("falls back to an untracked read when the path is not in the change list", async () => {
    projectDiff.mockResolvedValue(changed([{ path: "other.rs", change: "modified" }]));
    fileDiff.mockResolvedValue("+fn main() {}");

    await openArtifactInDiff("p1", "agent-1", "src/auth.rs");

    expect(fileDiff).toHaveBeenCalledWith("p1", "src/auth.rs", true, "agent-1");
    expect(useDiffStore.getState().selected).toBe("src/auth.rs");
  });

  it("does nothing for a directory", async () => {
    await openArtifactInDiff("p1", "agent-1", "src/");

    expect(useUiStore.getState().tab).toBe("terminals");
    expect(projectDiff).not.toHaveBeenCalled();
  });
});

describe("artifactPreviewKind", () => {
  it("allows markdown and raster images", () => {
    expect(artifactPreviewKind("notes.md")).toBe("markdown");
    expect(artifactPreviewKind(".grokspace/graphs/artifacts/brief.markdown")).toBe(
      "markdown",
    );
    expect(artifactPreviewKind("shot.PNG")).toBe("image");
    expect(artifactPreviewKind("a/b/c.webp")).toBe("image");
  });

  it("refuses HTML, SVG, and unknown types", () => {
    expect(artifactPreviewKind("payload.html")).toBeNull();
    expect(artifactPreviewKind("payload.htm")).toBeNull();
    expect(artifactPreviewKind("icon.svg")).toBeNull();
    expect(artifactPreviewKind("search-results.json")).toBeNull();
    expect(artifactPreviewKind("drafts/")).toBeNull();
  });
});

describe("claimedArtifactPaths", () => {
  it("keeps unique file paths in node order and drops directories", () => {
    expect(
      claimedArtifactPaths([
        { data: { artifactPath: ".grokspace/graphs/plan.md" } },
        { data: { artifactPath: ".grokspace/graphs/artifacts/drafts/" } },
        { data: { artifactPath: ".grokspace/graphs/plan.md" } },
        { data: { artifactPath: "src/auth.rs" } },
        { data: {} },
      ]),
    ).toEqual([".grokspace/graphs/plan.md", "src/auth.rs"]);
  });
});

describe("claimedPathsFromMemory", () => {
  it("takes a lone relative path", () => {
    expect(claimedPathsFromMemory("src/auth.rs")).toEqual(["src/auth.rs"]);
    expect(claimedPathsFromMemory("`.grokspace/graphs/artifacts/brief.md`")).toEqual([
      ".grokspace/graphs/artifacts/brief.md",
    ]);
  });

  it("extracts backtick paths and ignores URLs", () => {
    expect(
      claimedPathsFromMemory(
        "Brief at `.grokspace/graphs/artifacts/brief.md`; UI on https://localhost:3000",
      ),
    ).toEqual([".grokspace/graphs/artifacts/brief.md"]);
  });
});

describe("uniqueFileArtifacts", () => {
  it("drops empties and directories", () => {
    expect(uniqueFileArtifacts(undefined, "  ", "a.md", "a.md", "b/")).toEqual(["a.md"]);
  });
});

describe("openArtifactInFinder", () => {
  it("reveals a file and ignores directories", async () => {
    revealArtifact.mockResolvedValue(undefined);

    await openArtifactInFinder("p1", "agent-1", "src/auth.rs");
    expect(revealArtifact).toHaveBeenCalledWith("p1", "src/auth.rs", "agent-1");

    revealArtifact.mockClear();
    await openArtifactInFinder("p1", null, "src/");
    expect(revealArtifact).not.toHaveBeenCalled();
  });
});
