import { describe, expect, it } from "vitest";

import {
  BATON_ROLES,
  batonPrompt,
  briefPrompt,
  capabilityProfileFor,
  ROLES,
  rolesInPlay,
  sourceGraphFile,
} from "./roles";

describe("the role presets", () => {
  it("are the five the roadmap names", () => {
    expect(ROLES.map((role) => role.name)).toEqual([
      "Planner",
      "Coder",
      "Reviewer",
      "Tester",
      "Scout",
    ]);
  });

  it("each say what they are for and what to do", () => {
    for (const role of ROLES) {
      expect(role.summary.length, `${role.name} needs a summary for the picker`).toBeGreaterThan(
        10,
      );
      expect(role.brief.length, `${role.name} needs a brief worth sending`).toBeGreaterThan(80);
    }
  });

  it("stay short enough to leave room for the work", () => {
    // These are read at the start of a session alongside the project memory and the
    // task. A brief that crowds those out is a brief that made the session worse.
    for (const role of ROLES) {
      expect(briefPrompt(role).length, `${role.name} is too long`).toBeLessThan(600);
    }
  });

  it("can be found by the name stored on a session", () => {
    expect(ROLES.find((role) => role.name === "Reviewer")?.summary).toContain("change");
    expect(ROLES.find((role) => role.name === "Nonesuch")).toBeUndefined();
    expect(BATON_ROLES.map((role) => role.name)).toEqual(["Coder", "Reviewer"]);
  });
});

describe("briefPrompt", () => {
  it("is one line, because a newline submits in a TUI", () => {
    // A brief spread over several lines would arrive as several prompts, most of them
    // fragments — the same reason a dispatched task is flattened.
    for (const role of ROLES) {
      expect(briefPrompt(role), `${role.name} spans lines`).not.toContain("\n");
    }
  });

  it("names the memory file rather than pasting the memory", () => {
    // Naming it keeps the brief the same length however much the project remembers,
    // and it is unconditional because the file always exists for a session GrokSpace
    // started — an empty one says there is nothing to know.
    for (const role of ROLES) {
      expect(briefPrompt(role)).toContain("$GROKSPACE_MEMORY_FILE");
    }
  });

  it("keeps the role's own words", () => {
    const scout = ROLES.find((role) => role.name === "Scout");
    expect(scout).toBeDefined();
    expect(briefPrompt(scout!)).toContain("change nothing");
  });

  it("appends the closed capability line", () => {
    const planner = ROLES.find((role) => role.name === "Planner")!;
    const coder = ROLES.find((role) => role.name === "Coder")!;
    const reviewer = ROLES.find((role) => role.name === "Reviewer")!;
    expect(briefPrompt(planner)).toContain("graph, steps, and memory");
    expect(briefPrompt(coder)).toContain("write in the worktree");
    expect(briefPrompt(reviewer)).toContain("do not write the project tree");
  });
});

describe("capabilityProfileFor", () => {
  it("closes Planner/Scout on host paths, Coder on worktree write, Reviewer/Tester on review", () => {
    expect(capabilityProfileFor("Planner")?.kind).toBe("read");
    expect(capabilityProfileFor("Scout")?.writePrefixes).toEqual([".grokspace/", "$GROKSPACE_"]);
    expect(capabilityProfileFor("Coder")?.writePrefixes).toBeNull();
    expect(capabilityProfileFor("Reviewer")?.writePrefixes).toEqual([]);
    expect(capabilityProfileFor("Tester")?.kind).toBe("review");
    expect(capabilityProfileFor("Validator")?.kind).toBe("review");
  });

  it("does not invent a write coordinator", () => {
    expect(capabilityProfileFor("Coordinator")).toBeUndefined();
    expect(capabilityProfileFor(null)).toBeUndefined();
    expect(capabilityProfileFor("")).toBeUndefined();
  });
});

describe("rolesInPlay", () => {
  const session = (role: string | null, status = "running") => ({ role, status });

  it("names the roles a live session is covering", () => {
    const covered = rolesInPlay([session("Planner"), session("Reviewer", "idle")]);

    expect([...covered].sort()).toEqual(["Planner", "Reviewer"]);
  });

  it("does not count a session that has stopped", () => {
    // Its role is no longer being done, so offering to start it again is the point.
    expect(rolesInPlay([session("Planner", "stopped")]).has("Planner")).toBe(false);
  });

  it("counts one that is waiting to be answered", () => {
    // needs_input is blocked, not finished, and starting a second Planner would not
    // unblock it.
    expect(rolesInPlay([session("Planner", "needs_input")]).has("Planner")).toBe(true);
  });

  it("ignores a session started by hand", () => {
    expect(rolesInPlay([session(null), session(null, "idle")]).size).toBe(0);
  });

  it("counts a role twice over only once", () => {
    expect(rolesInPlay([session("Planner"), session("Planner")]).size).toBe(1);
  });
});

describe("sourceGraphFile", () => {
  it("prefers a watched path and otherwise uses the project-tree file", () => {
    expect(sourceGraphFile("s1", "/p", "/watched/s1.json")).toBe("/watched/s1.json");
    expect(sourceGraphFile("s1", "/tmp/acme/", null)).toBe("/tmp/acme/.grokspace/graphs/s1.json");
  });
});

describe("batonPrompt", () => {
  const coder = ROLES.find((role) => role.name === "Coder")!;
  const graph = "/p/.grokspace/graphs/planner.json";

  it("names memory, the source graph as read-only, and the new session's own graph", () => {
    const prompt = batonPrompt({
      role: coder,
      sourceGraphPath: graph,
      approvedTitles: ["Lock the titles"],
      excerpt: "the plan is done",
    });

    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("$GROKSPACE_MEMORY_FILE");
    expect(prompt).toContain(graph);
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("$GROKSPACE_GRAPH_FILE");
    expect(prompt).toContain("1. Lock the titles");
    expect(prompt).toContain("the plan is done");
  });

  it("omits proposed-looking titles when none were approved", () => {
    const prompt = batonPrompt({ role: coder, sourceGraphPath: graph, approvedTitles: [], excerpt: "" });
    expect(prompt).not.toContain("Approved steps");
    expect(prompt).not.toContain("Excerpt:");
  });
});
