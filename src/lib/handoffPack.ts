/**
 * Handoff pack (FEAT-032): files on disk, not a URL. Import is not built here.
 */

import { useSessionStore } from "../stores/sessionStore";
import { api, errorMessage } from "./api";

/** Always written. `ledger-tail.jsonl` is omitted when FEAT-015 has no file yet. */
export const HANDOFF_PACK_FILES = [
  "graph.json",
  "steps.json",
  "memory.md",
  "transcript.md",
  "changes.patch",
] as const;

export const HANDOFF_LEDGER_FILE = "ledger-tail.jsonl";

/** Tail of the conversation, in Unicode scalar values. */
export const HANDOFF_TRANSCRIPT_CHARS = 8 * 1024;

export function isHandoffSecretPath(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").some((segment) => {
    const name = segment.replaceAll('"', "");
    return (
      name === ".env" ||
      name.startsWith(".env.") ||
      name === "worktreeinclude" ||
      name === ".worktreeinclude"
    );
  });
}

export function formatTranscriptMd(entries: readonly { kind: string; text: string }[]): string {
  return entries
    .filter((entry) => entry.text.trim() !== "")
    .map((entry) => `## ${entry.kind}\n\n${entry.text}\n`)
    .join("\n");
}

export function capHandoffTranscript(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= HANDOFF_TRANSCRIPT_CHARS) return text;
  return chars.slice(chars.length - HANDOFF_TRANSCRIPT_CHARS).join("");
}

/** Palette already closed. Cancel is a silent `null` from the native picker. */
export async function exportHandoffPack(sessionId: string): Promise<void> {
  const transcript = capHandoffTranscript(
    formatTranscriptMd(useSessionStore.getState().transcript[sessionId] ?? []),
  );
  try {
    await api.exportSessionPack(sessionId, transcript);
  } catch (error) {
    useSessionStore.getState().setError(errorMessage(error));
  }
}
