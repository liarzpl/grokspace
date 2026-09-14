/**
 * Which session graphs and step lists to read now vs after first paint.
 *
 * Project open used to fan out one IPC per session for both, even on Terminals.
 * Visible chips/panes go first; the rest wait for idle. The effect key is a NUL
 * join so a future non-UUID id cannot split the way a space join would.
 */

import type { WorkspaceTab } from "../stores/uiStore";

/** Stable identity for the sessions on screen. Ids themselves have no NUL. */
export function sessionIdKey(ids: readonly string[]): string {
  return ids.join("\0");
}

export function sessionIdsFromKey(key: string): string[] {
  return key === "" ? [] : key.split("\0");
}

/**
 * Runs after the current turn so the first paint of the visible pane is not
 * waiting on every other session's files. `requestIdleCallback` when the host
 * has it; a 0-timer otherwise (tests, older WebKit).
 */
export function scheduleIdle(work: () => void): () => void {
  const idle = globalThis.requestIdleCallback;
  if (typeof idle === "function") {
    const handle = idle(() => work());
    return () => globalThis.cancelIdleCallback(handle);
  }
  const timer = setTimeout(work, 0);
  return () => clearTimeout(timer);
}

export interface SidecarLoadPlan {
  immediate: string[];
  deferred: string[];
}

/**
 * Terminals: pane sessions (the grid and its face dots). Graph: the selected
 * session (or the first) so the canvas and rail fill; chips catch up idle.
 * Other tabs do not show those dots, so everything waits.
 */
export function sidecarLoadPlan(input: {
  sessionIds: readonly string[];
  paneSessionIds: readonly string[];
  tab: WorkspaceTab;
  selectedGraphId: string | null;
}): SidecarLoadPlan {
  const all: string[] = [];
  const seen = new Set<string>();
  for (const id of input.sessionIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    all.push(id);
  }

  const pane = new Set(input.paneSessionIds.filter((id) => seen.has(id)));
  const immediate: string[] = [];
  const take = (id: string | null | undefined) => {
    if (id === undefined || id === null || !seen.has(id)) return;
    if (immediate.includes(id)) return;
    immediate.push(id);
  };

  if (input.tab === "terminals") {
    for (const id of all) {
      if (pane.has(id)) take(id);
    }
  } else if (input.tab === "graph") {
    const selected =
      input.selectedGraphId !== null && seen.has(input.selectedGraphId)
        ? input.selectedGraphId
        : (all[0] ?? null);
    take(selected);
  }

  return {
    immediate,
    deferred: all.filter((id) => !immediate.includes(id)),
  };
}
