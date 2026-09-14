/**
 * Permission prompts that have nowhere else to appear.
 *
 * Allow/Deny live on the task card when the agent is assigned to a task. Swarm
 * launches and palette-started agents have no card, and without this they stay
 * `needs_input` with no way to answer.
 */

import type {
  PermissionOption,
  PermissionPolicyRule,
  PermissionRequest,
  Task,
} from "../types";
import { capabilityProfileFor } from "./roles";

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

/**
 * Accessible name for the orphaned-permission strip. Isolation already uses
 * `role="status"`; this prompt is the one that blocks an agent, so the name
 * has to include who is waiting.
 */
export function orphanedPermissionAlert(titles: readonly string[]): string {
  const unique = [...new Set(titles.map((title) => title.trim()).filter(Boolean))];
  if (unique.length === 0) return "An agent needs permission";
  if (unique.length === 1) return `${unique[0]} needs permission`;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]} need permission`;
  const last = unique[unique.length - 1];
  return `${unique.slice(0, -1).join(", ")}, and ${last} need permission`;
}

/** Same outcomes as Rust `policy::decide`. Deny wins; a bad glob is skipped. */
export type PolicyDecision = "deny" | "ask" | "allow-once-similar";

const WRITE_TOOLS = new Set(["edit", "write", "delete", "move", "create"]);

/**
 * FEAT-014 matcher. `None` in Rust is `null` here: the glob is unusable
 * (skip the rule; never Always). `*` / `**` match any run; `?` is one character.
 */
export function policyGlobMatches(pattern: string, text: string): boolean | null {
  if (!globOk(pattern)) return null;
  return globAt(pattern, text);
}

export function decidePolicy(
  rules: readonly PermissionPolicyRule[],
  summary: string,
): PolicyDecision {
  let deny = false;
  let ask = false;
  let allow = false;
  for (const rule of rules) {
    if (policyGlobMatches(rule.pattern, summary) !== true) continue;
    if (rule.action === "deny") deny = true;
    else if (rule.action === "ask") ask = true;
    else if (rule.action === "allow-once-similar" && !tooWideAllow(rule.pattern)) {
      allow = true;
    }
  }
  if (deny) return "deny";
  if (ask) return "ask";
  if (allow) return "allow-once-similar";
  return "ask";
}

/**
 * Whether this role's closed profile would deny the summary. Suggestion
 * only — callers must not auto-answer Deny (that stalls ACP).
 */
export function roleSuggestsDeny(role: string | null | undefined, summary: string): boolean {
  const profile = capabilityProfileFor(role);
  if (profile === undefined) return false;
  if (decidePolicy(profile.rules, summary) === "deny") return true;
  if (profile.writePrefixes === null) return false;
  const path = writePathOf(summary);
  if (path === null) return false;
  return !profile.writePrefixes.some((prefix) => pathAllowedByPrefix(path, prefix));
}

export function roleDenySuggestion(
  role: string | null | undefined,
  summary: string,
): string | null {
  if (!roleSuggestsDeny(role, summary)) return null;
  if (role === null || role === undefined || role.trim() === "") return null;
  return `${role} profile suggests Deny`;
}

function tooWideAllow(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  for (const ch of trimmed) {
    if (ch !== "*" && ch !== "?") return false;
  }
  return true;
}

function globOk(pattern: string): boolean {
  if (pattern === "" || pattern.endsWith("\\")) return false;
  let opens = 0;
  let closes = 0;
  for (const ch of pattern) {
    if (ch === "[") opens += 1;
    if (ch === "]") closes += 1;
  }
  return opens === closes;
}

function globAt(pat: string, text: string): boolean {
  if (pat === "") return text === "";
  if (pat.startsWith("*")) {
    const rest = pat.replace(/^\*+/, "");
    if (rest === "") return true;
    let restText = text;
    for (;;) {
      if (globAt(rest, restText)) return true;
      const ch = restText.codePointAt(0);
      if (ch === undefined) return false;
      restText = restText.slice(String.fromCodePoint(ch).length);
    }
  }
  const wanted = pat.codePointAt(0);
  if (wanted === undefined) return false;
  const wantedStr = String.fromCodePoint(wanted);
  if (wantedStr === "?") {
    const ch = text.codePointAt(0);
    if (ch === undefined) return false;
    return globAt(pat.slice(wantedStr.length), text.slice(String.fromCodePoint(ch).length));
  }
  const ch = text.codePointAt(0);
  if (ch === undefined) return false;
  return (
    wanted === ch && globAt(pat.slice(wantedStr.length), text.slice(String.fromCodePoint(ch).length))
  );
}

function writePathOf(summary: string): string | null {
  const matched = /^([A-Za-z][\w-]*)\s+(.+)$/.exec(summary.trim());
  if (matched?.[1] === undefined || matched[2] === undefined) return null;
  if (!WRITE_TOOLS.has(matched[1].toLowerCase())) return null;
  let path = matched[2].replace(/^[`'"]+|[`'"]+$/g, "").trim().replace(/\\/g, "/");
  if (path.startsWith("./")) path = path.slice(2);
  return path === "" ? null : path;
}

function pathAllowedByPrefix(path: string, prefix: string): boolean {
  if (path === prefix || path.startsWith(prefix)) return true;
  return prefix.endsWith("/") && path === prefix.slice(0, -1);
}
