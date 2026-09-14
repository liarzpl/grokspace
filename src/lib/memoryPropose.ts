/**
 * Filing a named memory key from a transcript. `createEntry` is the only write;
 * the renderer must not touch the Markdown projection.
 */

import { MAX_MEMORY_CHARS } from "./limits";
import type { AgentUpdate, MemoryEntry } from "../types";

/** Note by default; context/decision if asked. Artifact is a later ID. */
export const MEMORY_PROPOSE_TYPES = ["note", "context", "decision"] as const;
export type MemoryProposeType = (typeof MEMORY_PROPOSE_TYPES)[number];
export const DEFAULT_MEMORY_PROPOSE_TYPE: MemoryProposeType = "note";

const KEY = "[A-Za-z][A-Za-z0-9._/-]{0,63}";
const MEMORY_KEY_LINE = new RegExp(
  `^memory\\s+key\\s*:\\s*(?:\`(${KEY})\`|(${KEY}))\\s*$`,
  "im",
);
const KEY_PHRASE = new RegExp(
  `(?:memory\\s+key|under(?:\\s+the)?\\s+key|name(?:s|d)?\\s+the\\s+key)\\s*[:=]?\\s*\`(${KEY})\``,
  "i",
);

export function namedMemoryKey(text: string): string | null {
  const line = MEMORY_KEY_LINE.exec(text);
  const fromLine = line?.[1] ?? line?.[2];
  if (fromLine !== undefined) return fromLine;
  return KEY_PHRASE.exec(text)?.[1] ?? null;
}

export function stripNamedKeyLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => !MEMORY_KEY_LINE.test(line))
    .join("\n")
    .trim();
}

export function draftFromTranscriptText(text: string): { key: string; content: string } {
  const key = namedMemoryKey(text) ?? "";
  return key === "" ? { key: "", content: text.trim() } : { key, content: stripNamedKeyLine(text) };
}

/** Named-key grok messages, or the last line so a human can file by hand. */
export function offersMemoryChip(entry: AgentUpdate, isLast: boolean): boolean {
  if (entry.text.trim() === "") return false;
  return isLast || (entry.kind === "message" && namedMemoryKey(entry.text) !== null);
}

/** Same budget as Rust: this key replaces its own previous size. Code points. */
export function memoryWouldExceedCap(
  entries: MemoryEntry[],
  key: string,
  content: string,
): boolean {
  const existing = entries
    .filter((entry) => entry.key !== key.trim())
    .reduce((total, entry) => total + [...entry.content].length, 0);
  return existing + [...content.trim()].length > MAX_MEMORY_CHARS;
}
