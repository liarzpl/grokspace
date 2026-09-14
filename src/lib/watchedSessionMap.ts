/**
 * Coalesced refresh for a per-session map driven by a directory watcher.
 *
 * Graph and steps used to each keep `COALESCE_MS` + a `pending` Map. The
 * closed-session rule already diverged: graph keeps an entry it is holding,
 * steps forgets. That difference is the `onClosed` option, not a second copy
 * of the timer.
 */

export const COALESCE_MS = 80;

export type ClosedWatchPolicy = "keep-if-present" | "forget";

export function createWatchedSessionMap(options: {
  coalesceMs?: number;
  onClosed: ClosedWatchPolicy;
}) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const ms = options.coalesceMs ?? COALESCE_MS;

  const cancel = (sessionId: string) => {
    const queued = pending.get(sessionId);
    if (queued !== undefined) {
      clearTimeout(queued);
      pending.delete(sessionId);
    }
  };

  const refresh = (
    sessionId: string,
    isOpenSession: boolean,
    handlers: {
      hasEntry: () => boolean;
      load: () => void;
      forget: () => void;
    },
  ) => {
    if (!isOpenSession) {
      if (options.onClosed === "forget") {
        handlers.forget();
        return;
      }
      if (!handlers.hasEntry()) return;
    }
    cancel(sessionId);
    pending.set(
      sessionId,
      setTimeout(() => {
        pending.delete(sessionId);
        handlers.load();
      }, ms),
    );
  };

  return { refresh, cancel };
}
