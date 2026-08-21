import { describe, expect, it } from "vitest";

import type { PathOverlap } from "../types";
import {
  overlapFor,
  overlapMarkTitle,
  overlapStrip,
  overlapsOf,
} from "./overlap";

const reviewer: PathOverlap = {
  path: "src/lib.rs",
  hotspot: false,
  peers: [{ sessionId: "agent-2", title: "Reviewer" }],
};

const lockfile: PathOverlap = {
  path: "Cargo.lock",
  hotspot: true,
  peers: [{ sessionId: "agent-2", title: "Reviewer" }],
};

describe("overlapsOf", () => {
  it("reads the list off a changed or clean payload", () => {
    expect(
      overlapsOf({ state: "changed", branch: "main", files: [], overlaps: [reviewer] }),
    ).toEqual([reviewer]);
    expect(overlapsOf({ state: "clean", branch: "main", overlaps: [reviewer] })).toEqual([
      reviewer,
    ]);
  });

  it("is empty when git cannot answer, or when the list is absent", () => {
    expect(overlapsOf({ state: "gitMissing" })).toEqual([]);
    expect(overlapsOf({ state: "notARepo" })).toEqual([]);
    expect(overlapsOf({ state: "clean", branch: "main" })).toEqual([]);
  });
});

describe("overlapFor", () => {
  it("finds the row for a path", () => {
    expect(overlapFor([reviewer, lockfile], "Cargo.lock")).toEqual(lockfile);
    expect(overlapFor([reviewer], "missing.rs")).toBeUndefined();
  });
});

describe("overlapMarkTitle", () => {
  it("names the other session on an ordinary path", () => {
    expect(overlapMarkTitle(reviewer)).toBe("Also touched by Reviewer");
  });

  it("speaks louder on a lockfile or migration", () => {
    expect(overlapMarkTitle(lockfile)).toBe(
      "Reviewer also touched this lockfile or migration",
    );
  });

  it("calls a nameless session Agent, and a null id the project", () => {
    expect(
      overlapMarkTitle({
        path: "src/lib.rs",
        hotspot: false,
        peers: [{ sessionId: "agent-2", title: null }],
      }),
    ).toBe("Also touched by Agent");
    expect(
      overlapMarkTitle({
        path: "src/lib.rs",
        hotspot: false,
        peers: [{ sessionId: null, title: null }],
      }),
    ).toBe("Also touched by the project");
  });
});

describe("overlapStrip", () => {
  it("is silent when nothing overlaps", () => {
    expect(overlapStrip([])).toBeNull();
  });

  it("names the other session without refusing Merge", () => {
    expect(overlapStrip([reviewer])).toBe("Also touched by Reviewer.");
  });

  it("joins two peers, and lists three with a comma", () => {
    const two: PathOverlap = {
      path: "src/lib.rs",
      hotspot: false,
      peers: [
        { sessionId: "a", title: "Reviewer" },
        { sessionId: "b", title: "Coder" },
      ],
    };
    expect(overlapStrip([two])).toBe("Also touched by Reviewer and Coder.");

    const three: PathOverlap = {
      path: "src/lib.rs",
      hotspot: false,
      peers: [
        { sessionId: "a", title: "Reviewer" },
        { sessionId: "b", title: "Coder" },
        { sessionId: null, title: null },
      ],
    };
    expect(overlapStrip([three])).toBe(
      "Also touched by Reviewer, Coder, and the project.",
    );
  });

  it("raises lockfiles and migrations without locking Merge", () => {
    expect(overlapStrip([lockfile])).toBe(
      "Cargo.lock is also touched by Reviewer. Lockfiles and migrations conflict more often.",
    );
  });

  it("names two hotspots, then summarises a longer list", () => {
    const packageLock: PathOverlap = {
      path: "package-lock.json",
      hotspot: true,
      peers: [{ sessionId: "agent-2", title: "Reviewer" }],
    };
    expect(overlapStrip([lockfile, packageLock])).toBe(
      "Cargo.lock and package-lock.json are also touched by Reviewer. Lockfiles and migrations conflict more often.",
    );

    const migration: PathOverlap = {
      path: "src-tauri/migrations/0001_initial.sql",
      hotspot: true,
      peers: [{ sessionId: "agent-2", title: "Reviewer" }],
    };
    expect(overlapStrip([lockfile, packageLock, migration])).toBe(
      "Cargo.lock and 2 other generated files are also touched by Reviewer. Lockfiles and migrations conflict more often.",
    );
  });
});
