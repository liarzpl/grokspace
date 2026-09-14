import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Local file log. The host appends to `~/.grokspace/logs/grokspace.log`.
 * This is not telemetry: the command writes a line and returns.
 */

export function clientErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** Write/resize after the pty is gone, and attach to a reconciled row. */
export function isQuietHostError(error: unknown): boolean {
  const message = clientErrorMessage(error);
  return (
    message === "that session is no longer running" ||
    message.startsWith("no session found with id ")
  );
}

export function logClientError(source: string, message: string): void {
  void invoke("log_client_error", { source, message }).catch(() => {
    // The log command is best-effort. Recursing or bannering it would hide the
    // original failure.
  });
}

export function logCaught(source: string, error: unknown): string {
  const message = clientErrorMessage(error);
  logClientError(source, message);
  return message;
}

/** Same as `listen`, but a failed subscribe is written to the local log. */
export function listenLogged<T>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, handler).catch((error) => {
    logClientError("listen", `${event}: ${clientErrorMessage(error)}`);
    return () => {};
  });
}
