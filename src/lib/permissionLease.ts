/**
 * Session-scoped allow-similar leases (FEAT-005).
 *
 * After a human Allow, a chip can grant `Edit src/**` for this session id only.
 * Matching prompts call Allow with no always `optionId`. Leases live in memory:
 * Stop / Restart (new id) drop them. `*` and any Bash are refused. Nothing is
 * written as `allow_always`.
 */

import type { PermissionRequest, Session } from "../types";
import { ALLOW_ONCE, roleSuggestsDeny } from "./permissions";

/** One lease: this session, this file tool, this path prefix (or exact file). */
export interface SessionLease {
  tool: string;
  prefix: string;
}

const FILE_TOOLS = new Set(["edit", "write", "read", "delete", "move", "create"]);
const BASH_TOOLS = new Set(["bash", "shell", "execute", "run", "exec"]);

const leases = new Map<string, SessionLease[]>();

export function resetSessionLeases(): void {
  leases.clear();
}

/** Drop leases whose session is gone (Restart) or `stopped` (Stop). */
export function syncSessionLeases(
  sessions: readonly Pick<Session, "id" | "status">[],
): void {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const id of [...leases.keys()]) {
    const row = byId.get(id);
    if (row === undefined || row.status === "stopped") {
      leases.delete(id);
    }
  }
}

export function grantSessionLease(
  sessionId: string,
  lease: SessionLease,
  role?: string | null,
): boolean {
  if (role !== undefined && role !== null && role !== "") {
    const sample = lease.prefix.endsWith("/")
      ? `${lease.tool} ${lease.prefix}file`
      : `${lease.tool} ${lease.prefix}`;
    if (roleSuggestsDeny(role, sample)) return false;
  }
  if (isBashTool(lease.tool) || isTooWide(lease.prefix)) return false;
  if (!FILE_TOOLS.has(lease.tool.toLowerCase())) return false;
  const next: SessionLease = {
    tool: displayTool(lease.tool),
    prefix: lease.prefix,
  };
  const existing = leases.get(sessionId) ?? [];
  if (existing.some((row) => sameLease(row, next))) return true;
  leases.set(sessionId, [...existing, next]);
  return true;
}

/**
 * Scope the human can opt into for this summary, or null when it would be
 * Bash, `*`, or otherwise too wide / not a file path.
 */
export function proposedLease(summary: string, role?: string | null): SessionLease | null {
  if (roleSuggestsDeny(role, summary)) return null;
  const call = parseCall(summary);
  if (call === null) return null;
  if (isBashTool(call.tool) || !FILE_TOOLS.has(call.tool.toLowerCase())) {
    return null;
  }
  const prefix = prefixOf(call.path);
  if (isTooWide(prefix)) return null;
  return { tool: displayTool(call.tool), prefix };
}

export function leaseLabel(lease: SessionLease): string {
  return lease.prefix.endsWith("/")
    ? `${lease.tool} ${lease.prefix}**`
    : `${lease.tool} ${lease.prefix}`;
}

export function matchSessionLease(
  sessionId: string,
  summary: string,
  sessions?: readonly (Pick<Session, "id" | "status"> & { role?: string | null })[],
): SessionLease | undefined {
  let role: string | null | undefined;
  if (sessions !== undefined) {
    const row = sessions.find((session) => session.id === sessionId);
    if (row === undefined || row.status === "stopped") return undefined;
    role = row.role;
  }
  const held = leases.get(sessionId);
  if (held === undefined) return undefined;
  return held.find((lease) => leaseMatches(lease, summary, role));
}

export function leaseCanAutoAnswer(request: PermissionRequest): boolean {
  return (request.options ?? []).some((option) => option.kind === ALLOW_ONCE);
}

export function leaseMatches(
  lease: SessionLease,
  summary: string,
  role?: string | null,
): boolean {
  if (roleSuggestsDeny(role, summary)) return false;
  const call = parseCall(summary);
  if (call === null) return false;
  if (call.tool.toLowerCase() !== lease.tool.toLowerCase()) return false;
  if (lease.prefix.endsWith("/")) {
    return call.path === lease.prefix.slice(0, -1) || call.path.startsWith(lease.prefix);
  }
  return call.path === lease.prefix;
}

function parseCall(summary: string): { tool: string; path: string } | null {
  const text = summary.trim();
  const matched = /^([A-Za-z][\w-]*)\s+(.+)$/.exec(text);
  if (matched === null || matched[1] === undefined || matched[2] === undefined) {
    return null;
  }
  const tool = matched[1];
  const path = normalizePath(matched[2].replace(/^[`'"]+|[`'"]+$/g, "").trim());
  if (path === null) return null;
  return { tool, path };
}

function normalizePath(path: string): string | null {
  let next = path.trim().replace(/\\/g, "/");
  if (next.startsWith("./")) next = next.slice(2);
  if (next === "" || next.startsWith("/") || next.split("/").includes("..")) {
    return null;
  }
  if (next.includes("*")) return null;
  if (/\s/.test(next) && !next.includes("/")) return null;
  return next;
}

function prefixOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash + 1);
}

function isTooWide(prefix: string): boolean {
  const trimmed = prefix.trim();
  if (trimmed === "" || trimmed === "/" || trimmed === "." || trimmed === "./") {
    return true;
  }
  return trimmed.includes("*");
}

function isBashTool(tool: string): boolean {
  return BASH_TOOLS.has(tool.toLowerCase());
}

function displayTool(tool: string): string {
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}

function sameLease(a: SessionLease, b: SessionLease): boolean {
  return a.tool === b.tool && a.prefix === b.prefix;
}
