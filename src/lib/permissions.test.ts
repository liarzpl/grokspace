import { describe, expect, it } from "vitest";

import type { PermissionRequest, Task } from "../types";
import { orphanedPermissions } from "./permissions";

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
  return { requestId: 1, summary: "Write a file", ...overrides };
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
