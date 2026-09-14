/**
 * Facts under a permission prompt. Session title, the `doing` step, worktree
 * path, and overlapping diff paths — values only, never a guessed sentence.
 */

import type { DiffState, Session, SessionStep } from "../types";
import { overlapPathsOf } from "./overlap";
import { homeRelative } from "./paths";

function trimFact(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text !== undefined && text !== "" ? text : null;
}

/** First `doing` title in list order, or null when none is in progress. */
export function doingStepTitle(steps: readonly SessionStep[]): string | null {
  return trimFact(steps.find((step) => step.status === "doing")?.title);
}

/**
 * Overlap paths from the diff already on screen for this session.
 * Another session's (or the project's) loaded diff is not this ask's.
 */
export function loadedOverlapPaths(
  diff: DiffState,
  scope: string | null,
  sessionId: string,
  loaded: boolean,
): string[] {
  if (!loaded || scope !== sessionId) return [];
  return overlapPathsOf(diff);
}

/**
 * One line of known facts, or null when every piece is missing.
 * Pieces are omitted, not replaced with "Agent" / "Session".
 */
export function permissionWhyText(input: {
  title?: string | null;
  doingTitle?: string | null;
  worktreePath?: string | null;
  overlapPaths?: readonly string[];
}): string | null {
  const parts: string[] = [];
  const title = trimFact(input.title);
  if (title !== null) parts.push(title);
  const doing = trimFact(input.doingTitle);
  if (doing !== null) parts.push(doing);
  const tree = trimFact(input.worktreePath);
  if (tree !== null) parts.push(homeRelative(tree));
  const paths = (input.overlapPaths ?? [])
    .map((path) => path.trim())
    .filter((path) => path !== "");
  if (paths.length > 0) parts.push(paths.join(", "));
  return parts.length === 0 ? null : parts.join(" · ");
}

export function permissionWhyFrom(
  session: Pick<Session, "title" | "worktreePath"> | undefined,
  steps: readonly SessionStep[],
  overlapPaths: readonly string[],
): string | null {
  return permissionWhyText({
    title: session?.title,
    doingTitle: doingStepTitle(steps),
    worktreePath: session?.worktreePath,
    overlapPaths,
  });
}
