import type { SessionStatus } from "../types";

/**
 * Fill colour for the 1.5-size session status dot.
 *
 * TaskBoard and SessionSteps used to each keep a copy. A third panel inventing
 * its own map is how a new status would light up in one place and stay grey
 * in another.
 */
export const SESSION_STATUS_TONE: Record<SessionStatus, string> = {
  running: "bg-accent",
  needs_input: "bg-warning",
  idle: "bg-success",
  stopped: "bg-line-strong",
};

export function sessionStatusTone(status: SessionStatus): string {
  return SESSION_STATUS_TONE[status];
}

export function statusDotClass(status: SessionStatus): string {
  return `size-1.5 shrink-0 rounded-full ${sessionStatusTone(status)}`;
}
