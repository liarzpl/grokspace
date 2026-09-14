/**
 * Inbox snooze: hide a Needs you wait from the rail without answering ACP.
 *
 * The agent still holds `needs_input`. The dock still counts it. Timestamps
 * live in `uiStore` and `~/.grokspace/inbox-snooze.json` so a quit mid-snooze
 * comes back: expired waits reappear on the next launch (missed-run).
 */

import { api } from "./api";
import { useUiStore } from "../stores/uiStore";

export type InboxSnoozeKind = "1h" | "tomorrow";

export const SNOOZE_HOUR_MS = 60 * 60 * 1000;
const TOMORROW_HOUR = 9;

/** 1h from `now`, or 09:00 local tomorrow. */
export function snoozeUntil(kind: InboxSnoozeKind, now: Date): number {
  if (kind === "1h") return now.getTime() + SNOOZE_HOUR_MS;
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(TOMORROW_HOUR, 0, 0, 0);
  return next.getTime();
}

export function isSnoozed(until: number | undefined, now: number): boolean {
  return until !== undefined && until > now;
}

export function pruneSnooze(
  until: Readonly<Record<string, number>>,
  now: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(until)) {
    if (at > now) next[id] = at;
  }
  return next;
}

function persist(until: Record<string, number>): void {
  void api.writeInboxSnooze(until).catch(() => {
    // Best-effort file. In-memory snooze still hides the rail item.
  });
}

/** Hide this wait. Does not answer the ACP permission. */
export function snoozeWait(sessionId: string, kind: InboxSnoozeKind, now = new Date()): number {
  const until = snoozeUntil(kind, now);
  useUiStore.getState().setSnooze(sessionId, until);
  persist(useUiStore.getState().snoozedUntil);
  return until;
}

/** Drop timers that have already fired, including a missed run after quit. */
export function wakeInboxSnooze(now = Date.now()): void {
  const before = useUiStore.getState().snoozedUntil;
  useUiStore.getState().dropExpiredSnooze(now);
  const after = useUiStore.getState().snoozedUntil;
  if (after !== before) persist(after);
}

/** Load `~/.grokspace/inbox-snooze.json`. A failed read shows every wait. */
export async function hydrateInboxSnooze(): Promise<void> {
  try {
    const loaded = await api.readInboxSnooze();
    const until = pruneSnooze(loaded, Date.now());
    useUiStore.getState().replaceSnooze(until);
    if (Object.keys(until).length !== Object.keys(loaded).length) persist(until);
  } catch {
    useUiStore.getState().replaceSnooze({});
  }
}
