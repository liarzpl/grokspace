import { describe, expect, it } from "vitest";

import { briefPrompt, roleByName, ROLES, rolesInPlay } from "./roles";

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
    expect(roleByName("Reviewer")?.summary).toContain("change");
    expect(roleByName("Nonesuch")).toBeUndefined();
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
    const scout = roleByName("Scout");
    expect(scout).toBeDefined();
    expect(briefPrompt(scout!)).toContain("change nothing");
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
