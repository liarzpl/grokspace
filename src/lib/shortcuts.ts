/**
 * The one place a keyboard shortcut is declared.
 *
 * Before this there was a single one, registered by hand in `App.tsx`. A second
 * added the same way would have been a second listener, and by the third nobody
 * could say which key belonged to what. Declaring them in a table also gives the
 * command palette half its content for free: it can list what it knows rather than
 * repeating the keys in prose.
 *
 * What is *not* here is the actions. Those need stores and React state, so the table
 * carries keys and words and `App` wires the ids to handlers — which is what keeps
 * this file pure enough to test.
 */

export type ShortcutId = "open-project" | "command-palette";

export interface Shortcut {
  id: ShortcutId;
  /** As `KeyboardEvent.key` reports it, lower-cased. */
  key: string;
  /** The platform's command modifier: Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
  /** What it does, in the words the palette will show. */
  label: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "command-palette", key: "k", mod: true, label: "Open the command palette" },
  { id: "open-project", key: "o", mod: true, label: "Open a project folder" },
];

/**
 * True where the command modifier is written Cmd rather than Ctrl.
 *
 * Only affects how a shortcut is *shown*; matching accepts either modifier, so a
 * wrong guess here costs a label and never a keystroke. Guarded because the tests
 * run in node, where there is no navigator.
 */
export function isApple(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
}

/** How to write a shortcut for a person to read. */
export function shortcutLabel(id: ShortcutId, apple = isApple()): string {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id);
  if (shortcut === undefined) return "";
  const key = shortcut.key.toUpperCase();
  if (!shortcut.mod) return key;
  return apple ? `⌘${key}` : `Ctrl+${key}`;
}

/**
 * Which shortcut an event is, if it is one.
 *
 * Either modifier counts, which is how the original Cmd+O behaved and is friendlier
 * than insisting on the platform's own. Anything with Alt or Shift held is not a
 * match: those are how a terminal sends characters GrokSpace has no business
 * intercepting.
 */
export function shortcutFor(event: KeyboardEvent): ShortcutId | undefined {
  if (event.altKey || event.shiftKey) return undefined;
  const mod = event.metaKey || event.ctrlKey;
  return SHORTCUTS.find(
    (shortcut) => shortcut.mod === mod && shortcut.key === event.key.toLowerCase(),
  )?.id;
}

/** What App does with a matched shortcut. Open-project closes the palette first. */
export function runGlobalShortcut(
  id: ShortcutId,
  deps: {
    closePalette: () => void;
    togglePalette: () => void;
    openProject: () => void;
  },
): void {
  if (id === "open-project") {
    deps.closePalette();
    deps.openProject();
    return;
  }
  deps.togglePalette();
}

/** A window-like target, so Escape can be subscribed without a real DOM. */
export interface KeyTarget {
  addEventListener: (type: "keydown", handler: (event: KeyboardEvent) => void) => void;
  removeEventListener: (type: "keydown", handler: (event: KeyboardEvent) => void) => void;
}

/**
 * Escape on the window, not on a div that is never focused. Settings is an overlay
 * whose dialog has no autofocus; without this the key does nothing.
 */
export function subscribeEscape(
  enabled: boolean,
  onEscape: () => void,
  target: KeyTarget | undefined = typeof window === "undefined" ? undefined : window,
): () => void {
  if (!enabled || target === undefined) return () => {};
  const handler = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onEscape();
  };
  target.addEventListener("keydown", handler);
  return () => target.removeEventListener("keydown", handler);
}
