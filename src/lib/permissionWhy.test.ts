import { describe, expect, it } from "vitest";

import type { Session, SessionStep } from "../types";
import {
  doingStepTitle,
  loadedOverlapPaths,
  permissionWhyFrom,
  permissionWhyText,
} from "./permissionWhy";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    paneId: null,
    processId: 1,
    status: "needs_input",
    title: "Coder",
    role: "Coder",
    worktreePath: "/Users/dev/acme/.grokspace/worktrees/s1",
    kind: "agent",
    exitCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function step(overrides: Partial<SessionStep> = {}): SessionStep {
  return {
    id: "a",
    sessionId: "s1",
    sortIndex: 0,
    title: "Write the login handler",
    status: "doing",
    origin: "agent",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("permissionWhyText", () => {
  it("joins the known facts and shortens a home worktree path", () => {
    expect(
      permissionWhyText({
        title: "Coder",
        doingTitle: "Write the login handler",
        worktreePath: "/Users/dev/acme/.grokspace/worktrees/s1",
        overlapPaths: ["src/lib.rs", "Cargo.lock"],
      }),
    ).toBe(
      "Coder · Write the login handler · ~/acme/.grokspace/worktrees/s1 · src/lib.rs, Cargo.lock",
    );
  });

  it("omits missing pieces instead of inventing Agent or a rationale", () => {
    expect(permissionWhyText({ title: "  ", doingTitle: null })).toBeNull();
    expect(permissionWhyText({ title: "Coder" })).toBe("Coder");
    expect(
      permissionWhyText({
        doingTitle: "Write the login handler",
        overlapPaths: ["", "  "],
      }),
    ).toBe("Write the login handler");
  });
});

describe("doingStepTitle", () => {
  it("takes the first doing title and ignores pending or blank ones", () => {
    expect(
      doingStepTitle([
        step({ id: "p", status: "pending", title: "Read auth.ts" }),
        step({ id: "d", status: "doing", title: "Write the login handler" }),
      ]),
    ).toBe("Write the login handler");
    expect(doingStepTitle([step({ status: "pending" })])).toBeNull();
    expect(doingStepTitle([step({ title: "   " })])).toBeNull();
  });
});

describe("loadedOverlapPaths", () => {
  const diff = {
    state: "changed" as const,
    branch: "grokspace/s1",
    files: [],
    overlaps: [{ path: "src/lib.rs", hotspot: false, peers: [] }],
  };

  it("uses the loaded diff for this session only", () => {
    expect(loadedOverlapPaths(diff, "s1", "s1", true)).toEqual(["src/lib.rs"]);
    expect(loadedOverlapPaths(diff, null, "s1", true)).toEqual([]);
    expect(loadedOverlapPaths(diff, "s2", "s1", true)).toEqual([]);
    expect(loadedOverlapPaths(diff, "s1", "s1", false)).toEqual([]);
  });
});

describe("permissionWhyFrom", () => {
  it("builds accessible text from a fixture session, doing step, and overlap", () => {
    expect(
      permissionWhyFrom(session(), [step()], ["src/auth.ts"]),
    ).toBe(
      "Coder · Write the login handler · ~/acme/.grokspace/worktrees/s1 · src/auth.ts",
    );
  });

  it("stays silent when the session and steps are missing", () => {
    expect(permissionWhyFrom(undefined, [], [])).toBeNull();
    expect(permissionWhyFrom(session({ title: null, worktreePath: null }), [], [])).toBeNull();
  });
});
