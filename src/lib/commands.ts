/**
 * What the command palette can do.
 *
 * A palette that lists every action in every store is a menu nobody reads, so this
 * is deliberately short: the things done often, and the things that today mean
 * aiming at a control a few pixels wide. Anything reachable in one obvious click
 * from where you already are is left out.
 *
 * Commands hold closures rather than being data the palette interprets, and they
 * reach their stores through `getState` rather than hooks — a command list is built
 * outside React's render, and a hook there would be a rules-of-hooks violation
 * waiting for someone to add a condition.
 */

import { useMemoryStore } from "../stores/memoryStore";
import { layoutOf, useProjectStore } from "../stores/projectStore";
import { useGraphStore } from "../stores/graphStore";
import { sessionForPane, useSessionStore } from "../stores/sessionStore";
import { TABS, useUiStore } from "../stores/uiStore";
import { paneCount, PANE_LAYOUTS, type Project, type SessionKind } from "../types";
import { ROLES } from "./roles";
import type { ShortcutId } from "./shortcuts";

export interface Command {
  id: string;
  label: string;
  /** Shown beside the label, so a long list reads as sections without headings. */
  group: string;
  /** Named when a command also has a key of its own, so the palette can say so. */
  shortcut?: ShortcutId;
  run: () => void;
}

/** A session started from the palette has no terminal to measure yet. */
const FALLBACK_SIZE = { cols: 80, rows: 24 };

/**
 * The lowest-numbered pane with nothing in it, or `undefined` when the grid is full.
 *
 * The palette cannot ask which pane you meant, so it picks the first free one and the
 * label says so.
 */
function firstFreePane(project: Project): string | undefined {
  const panes = Array.from({ length: paneCount(layoutOf(project)) }, (_, index) =>
    String(index),
  );
  const sessions = useSessionStore.getState().sessions;
  return panes.find((paneId) => sessionForPane(sessions, paneId) === undefined);
}

function startInFreePane(project: Project, kind: SessionKind) {
  const paneId = firstFreePane(project);
  if (paneId === undefined) {
    // Reported through the store the shell already watches, rather than silently
    // doing nothing to a command someone chose.
    useSessionStore.setState({ error: "Every pane in this layout is taken." });
    return;
  }
  void useSessionStore
    .getState()
    .startSession({ projectId: project.id, paneId, kind, ...FALLBACK_SIZE });
}

/**
 * Everything the palette offers right now.
 *
 * Rebuilt on each open rather than memoised: which projects exist and which panes
 * are free both change, and a stale list would offer to switch to a project that has
 * been forgotten.
 */
export function commands(project: Project | null): Command[] {
  const ui = useUiStore.getState();
  const list: Command[] = [];

  for (const { id, label } of TABS) {
    list.push({
      id: `tab-${id}`,
      label: `Show ${label.toLowerCase()}`,
      group: "View",
      run: () => ui.setTab(id),
    });
  }

  list.push({
    id: "open-settings",
    label: "Open settings",
    group: "View",
    run: () => ui.openSettings(),
  });

  list.push({
    id: "open-project",
    label: "Open a project folder…",
    group: "Project",
    shortcut: "open-project",
    run: () => {
      useUiStore.getState().closePalette();
      void useProjectStore.getState().pickAndOpenProject();
    },
  });

  for (const candidate of useProjectStore.getState().projects) {
    if (candidate.id === project?.id) continue;
    list.push({
      id: `switch-${candidate.id}`,
      label: `Switch to ${candidate.name}`,
      group: "Project",
      run: () => {
        useUiStore.getState().closePalette();
        void useProjectStore.getState().selectProject(candidate.id);
      },
    });
  }

  // Everything below needs somewhere to happen.
  if (project === null) return list;

  for (const layout of PANE_LAYOUTS) {
    list.push({
      id: `layout-${layout}`,
      label: `Use the ${layout} layout`,
      group: "Layout",
      run: () => {
        useUiStore.getState().closePalette();
        void useProjectStore.getState().setLayout(project.id, layout);
      },
    });
  }

  const starts: readonly { kind: SessionKind; label: string }[] = [
    { kind: "grok", label: "Start Grok in the first free pane" },
    { kind: "shell", label: "Start a shell in the first free pane" },
  ];
  for (const { kind, label } of starts) {
    list.push({
      id: `start-${kind}`,
      label,
      group: "Session",
      run: () => {
        useUiStore.getState().closePalette();
        startInFreePane(project, kind);
      },
    });
  }

  list.push({
    id: "start-agent",
    label: "Start an agent, which needs no pane",
    group: "Session",
    run: () => {
      useUiStore.getState().closePalette();
      void useSessionStore.getState().startSession({
        projectId: project.id,
        paneId: null,
        kind: "agent",
        ...FALLBACK_SIZE,
      });
    },
  });

  list.push({
    id: "launch-swarm",
    label: `Launch a swarm of all ${ROLES.length} roles`,
    group: "Session",
    run: () => {
      useUiStore.getState().closePalette();
      void useSessionStore.getState().launchSwarm(project.id, ROLES);
    },
  });

  list.push({
    id: "install-graph-skill",
    label: "Install or refresh the graph skill",
    group: "Skills",
    run: () => {
      useUiStore.getState().closePalette();
      void useGraphStore.getState().installSkill();
    },
  });

  list.push({
    id: "install-memory-skill",
    label: "Install or refresh the memory skill",
    group: "Skills",
    run: () => {
      useUiStore.getState().closePalette();
      void useMemoryStore.getState().installSkill();
    },
  });

  return list;
}

/**
 * The commands a query matches, in the order they were declared.
 *
 * Subsequence matching, not fuzzy scoring: "sgr" finds "Start Grok in the first free
 * pane". Ranking would need a score to tune and a tie to break, and this list is
 * short enough that declaration order is a better answer than a guess at relevance.
 */
export function matching(all: readonly Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...all];
  return all.filter((command) => isSubsequence(needle, command.label.toLowerCase()));
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const character of haystack) {
    if (character === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return at === needle.length;
}
