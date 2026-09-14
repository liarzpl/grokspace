import type { Project, Session, Task } from "../types";

/** Shared stand-ins so the first component tests do not each invent a project. */
export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "acme-api",
    path: "/Users/dev/acme-api",
    lastOpened: 1000,
    settings: { terminalLayout: "2x2" },
    createdAt: 1000,
    ...overrides,
  };
}

export function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    paneId: "0",
    processId: 4242,
    status: "running",
    title: "Grok",
    role: null,
    worktreePath: null,
    kind: "grok",
    exitCode: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "Fix the login bug",
    description: null,
    status: "backlog",
    assignedSessionId: null,
    priority: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}
