/**
 * Permission prompts that have nowhere else to appear.
 *
 * Allow/Deny live on the task card when the agent is assigned to a task. Swarm
 * launches and palette-started agents have no card, and without this they stay
 * `needs_input` with no way to answer.
 */

import type { PermissionOption, PermissionRequest, Task } from "../types";

export const ALLOW_ONCE = "allow_once";
export const REJECT_ONCE = "reject_once";
export const ALLOW_ALWAYS = "allow_always";
export const REJECT_ALWAYS = "reject_always";

/** One chip on a permission prompt: primary Allow/Deny, or a named extra. */
export interface PermissionChip {
  key: string;
  label: string;
  disabled: boolean;
  /** Primary Allow/Deny mapping; ignored by the backend when `optionId` is set. */
  allow: boolean;
  optionId?: string;
}

function optionByKind(
  options: readonly PermissionOption[],
  kind: string,
): PermissionOption | undefined {
  return options.find((option) => option.kind === kind);
}

function optionLabel(option: PermissionOption, fallback: string): string {
  const name = option.name.trim();
  return name === "" ? fallback : name;
}

/**
 * Primary Allow is `allow_once` only. `allow_always` / `reject_always` are
 * separate chips using the name the agent sent, so Allow can never silently
 * become always-approve.
 */
export function permissionChips(request: PermissionRequest): PermissionChip[] {
  const options = request.options ?? [];
  const allowOnce = optionByKind(options, ALLOW_ONCE);
  const rejectOnce = optionByKind(options, REJECT_ONCE);
  const chips: PermissionChip[] = [
    {
      key: ALLOW_ONCE,
      label: allowOnce ? optionLabel(allowOnce, "Allow") : "Allow",
      disabled: allowOnce === undefined,
      allow: true,
    },
    {
      key: REJECT_ONCE,
      label: rejectOnce ? optionLabel(rejectOnce, "Deny") : "Deny",
      disabled: rejectOnce === undefined,
      allow: false,
    },
  ];
  for (const option of options) {
    if (option.optionId === "") continue;
    if (option.kind !== ALLOW_ALWAYS && option.kind !== REJECT_ALWAYS) continue;
    chips.push({
      key: option.optionId,
      label: optionLabel(
        option,
        option.kind === ALLOW_ALWAYS ? "Always allow" : "Always deny",
      ),
      disabled: false,
      allow: option.kind === ALLOW_ALWAYS,
      optionId: option.optionId,
    });
  }
  return chips;
}

export function orphanedPermissions(
  permissions: Record<string, PermissionRequest[]>,
  tasks: readonly Task[],
  sessionIds: Iterable<string>,
): { sessionId: string; requests: PermissionRequest[] }[] {
  const assigned = new Set(
    tasks
      .map((task) => task.assignedSessionId)
      .filter((id): id is string => id !== null),
  );
  const live = new Set(sessionIds);
  return Object.entries(permissions)
    .filter(
      ([sessionId, requests]) =>
        requests.length > 0 && live.has(sessionId) && !assigned.has(sessionId),
    )
    .map(([sessionId, requests]) => ({ sessionId, requests }));
}
