import { describe, expect, it } from "vitest";

import type { PermissionOption, PermissionRequest, Task } from "../types";
import {
  decidePolicy,
  orphanedPermissionAlert,
  orphanedPermissions,
  permissionChips,
  policyGlobMatches,
  roleDenySuggestion,
  roleSuggestsDeny,
} from "./permissions";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "Fix login",
    description: null,
    status: "in_progress",
    assignedSessionId: null,
    priority: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return { requestId: 1, summary: "Write a file", options: [], ...overrides };
}

function option(overrides: Partial<PermissionOption> = {}): PermissionOption {
  return { optionId: "allow-once", name: "Allow once", kind: "allow_once", ...overrides };
}

describe("orphanedPermissions", () => {
  it("hides a prompt that already has a task card", () => {
    const permissions = { s1: [request()] };
    const tasks = [task({ assignedSessionId: "s1" })];

    expect(orphanedPermissions(permissions, tasks, ["s1"])).toEqual([]);
  });

  it("surfaces a prompt for an agent with no assigned task", () => {
    const permissions = { swarm: [request({ summary: "Run tests" })] };

    expect(orphanedPermissions(permissions, [task()], ["swarm"])).toEqual([
      { sessionId: "swarm", requests: [request({ summary: "Run tests" })] },
    ]);
  });

  it("ignores sessions that are not asking", () => {
    expect(orphanedPermissions({ s1: [] }, [], ["s1"])).toEqual([]);
  });

  it("hides a prompt whose session is not in this project", () => {
    const permissions = { foreign: [request()] };

    expect(orphanedPermissions(permissions, [], ["s1"])).toEqual([]);
  });
});

describe("permissionChips", () => {
  it("disables Allow when the agent only offered allow_always", () => {
    const chips = permissionChips(
      request({
        options: [
          option({ optionId: "always", name: "Always allow", kind: "allow_always" }),
          option({ optionId: "reject", name: "Reject", kind: "reject_once" }),
        ],
      }),
    );

    expect(chips.find((chip) => chip.key === "allow_once")).toMatchObject({
      disabled: true,
      allow: true,
    });
    expect(chips.find((chip) => chip.optionId === "always")).toMatchObject({
      label: "Always allow",
      allow: true,
    });
  });

  it("keeps Deny on reject_once and never folds always into it", () => {
    const chips = permissionChips(
      request({
        options: [
          option(),
          option({ optionId: "reject", name: "Reject", kind: "reject_once" }),
          option({ optionId: "never", name: "Always reject", kind: "reject_always" }),
        ],
      }),
    );

    const deny = chips.find((chip) => chip.key === "reject_once");
    expect(deny).toMatchObject({ disabled: false, allow: false });
    expect(deny?.optionId).toBeUndefined();
    expect(chips.find((chip) => chip.optionId === "never")?.label).toBe("Always reject");
  });

  it("does not treat an empty kind as Allow", () => {
    const chips = permissionChips(
      request({ options: [option({ optionId: "first", name: "Sure", kind: "" })] }),
    );

    expect(chips.find((chip) => chip.key === "allow_once")?.disabled).toBe(true);
    expect(chips.find((chip) => chip.key === "reject_once")?.disabled).toBe(true);
    expect(chips.some((chip) => chip.optionId !== undefined)).toBe(false);
  });

  it("surfaces the name the agent sent on every chip", () => {
    const chips = permissionChips(
      request({
        options: [
          option({ name: "Allow this run" }),
          option({ optionId: "reject", name: "No", kind: "reject_once" }),
        ],
      }),
    );

    expect(chips.find((chip) => chip.key === "allow_once")?.label).toBe("Allow this run");
    expect(chips.find((chip) => chip.key === "reject_once")?.label).toBe("No");
  });
});

describe("orphanedPermissionAlert", () => {
  it("names the waiting agent so a live region is not anonymous", () => {
    expect(orphanedPermissionAlert(["Planner"])).toBe("Planner needs permission");
    expect(orphanedPermissionAlert(["Planner", "Reviewer"])).toBe(
      "Planner and Reviewer need permission",
    );
    expect(orphanedPermissionAlert(["Planner", "Reviewer", "Scout"])).toBe(
      "Planner, Reviewer, and Scout need permission",
    );
  });

  it("falls back when titles are missing and de-duplicates repeats", () => {
    expect(orphanedPermissionAlert([])).toBe("An agent needs permission");
    expect(orphanedPermissionAlert(["", "  "])).toBe("An agent needs permission");
    expect(orphanedPermissionAlert(["Planner", "Planner"])).toBe("Planner needs permission");
  });
});

describe("FEAT-014 matcher", () => {
  it("lets deny win and skips a bad glob instead of Always", () => {
    const rules = [
      { action: "allow-once-similar" as const, pattern: "Edit **" },
      { action: "deny" as const, pattern: "Edit secrets/**" },
      { action: "deny" as const, pattern: "* rm*" },
    ];
    expect(decidePolicy(rules, "Edit src/auth.ts")).toBe("allow-once-similar");
    expect(decidePolicy(rules, "Edit secrets/token.env")).toBe("deny");
    expect(decidePolicy(rules, "Bash rm -rf /tmp")).toBe("deny");
    expect(policyGlobMatches("Edit src/[", "Edit src/auth.ts")).toBeNull();
    expect(decidePolicy([{ action: "allow-once-similar", pattern: "Edit src/[" }], "Edit src/auth.ts")).toBe(
      "ask",
    );
    expect(decidePolicy([{ action: "allow-once-similar", pattern: "*" }], "Edit a.ts")).toBe("ask");
  });
});

describe("role capability suggestions", () => {
  it("suggests Deny for Reviewer rm / merge / project-tree write, not for Coder src/", () => {
    expect(roleSuggestsDeny("Reviewer", "Bash rm -rf /tmp")).toBe(true);
    expect(roleSuggestsDeny("Reviewer", "git merge origin/main")).toBe(true);
    expect(roleSuggestsDeny("Reviewer", "Edit src/auth.ts")).toBe(true);
    expect(roleDenySuggestion("Reviewer", "Edit src/auth.ts")).toBe("Reviewer profile suggests Deny");
    expect(roleSuggestsDeny("Coder", "Edit src/auth.ts")).toBe(false);
    expect(roleDenySuggestion("Coder", "Edit src/auth.ts")).toBeNull();
    expect(roleSuggestsDeny("Planner", "Edit .grokspace/graphs/s.json")).toBe(false);
    expect(roleSuggestsDeny("Validator", "Write src/a.ts")).toBe(true);
    expect(roleSuggestsDeny(null, "Edit src/auth.ts")).toBe(false);
  });
});
