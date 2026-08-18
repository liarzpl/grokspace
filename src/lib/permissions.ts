/**
 * Permission prompts that have nowhere else to appear.
 *
 * Allow/Deny live on the task card when the agent is assigned to a task. Swarm
 * launches and palette-started agents have no card, and without this they stay
 * `needs_input` with no way to answer.
 */

import type { PermissionRequest, Task } from "../types";

export function orphanedPermissions(
  permissions: Record<string, PermissionRequest[]>,
  tasks: readonly Task[],
): { sessionId: string; requests: PermissionRequest[] }[] {
  const assigned = new Set(
    tasks
      .map((task) => task.assignedSessionId)
      .filter((id): id is string => id !== null),
  );
  return Object.entries(permissions)
    .filter(([sessionId, requests]) => requests.length > 0 && !assigned.has(sessionId))
    .map(([sessionId, requests]) => ({ sessionId, requests }));
}
