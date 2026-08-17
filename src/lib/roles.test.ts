import { describe, expect, it } from "vitest";

import { briefPrompt, roleByName, ROLES } from "./roles";

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
