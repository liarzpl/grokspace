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
 *
 * Inbox keys are a second table on purpose. They are not global: a focused grok
 * TUI must keep A/D/O/G, and ⌘K / ⌘O are the only combinations this app steals.
 */

export type GlobalShortcutId = "open-project" | "command-palette";
export type InboxShortcutId = "inbox-allow" | "inbox-deny" | "inbox-open" | "inbox-graph";
export type ShortcutId = GlobalShortcutId | InboxShortcutId;
export type ShortcutScope = "global" | "inbox";

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
 * Unmodified keys, only while the attention inbox or a permission chip is
 * focused. Snooze is a later feature; do not add it here.
 */
export const INBOX_SHORTCUTS: readonly Shortcut[] = [
  { id: "inbox-allow", key: "a", mod: false, label: "Allow once" },
  { id: "inbox-deny", key: "d", mod: false, label: "Deny" },
  { id: "inbox-open", key: "o", mod: false, label: "Open pane or card" },
  { id: "inbox-graph", key: "g", mod: false, label: "Show graph" },
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

function shortcutById(id: ShortcutId): Shortcut | undefined {
  return (
    SHORTCUTS.find((candidate) => candidate.id === id) ??
    INBOX_SHORTCUTS.find((candidate) => candidate.id === id)
  );
}

/** How to write a shortcut for a person to read. */
export function shortcutLabel(id: ShortcutId, apple = isApple()): string {
  const shortcut = shortcutById(id);
  if (shortcut === undefined) return "";
  const key = shortcut.key.toUpperCase();
  if (!shortcut.mod) return key;
  return apple ? `⌘${key}` : `Ctrl+${key}`;
}

/**
 * Which shortcut an event is, if it is one.
 *
 * Default scope is the global table (⌘K / ⌘O). Inbox scope is A/D/O/G
 * without a modifier. Either modifier counts for global keys, which is how
 * the original Cmd+O behaved. Alt or Shift is not a match: those are how a
 * terminal sends characters GrokSpace has no business intercepting.
 */
export function shortcutFor(event: KeyboardEvent, scope?: "global"): GlobalShortcutId | undefined;
export function shortcutFor(event: KeyboardEvent, scope: "inbox"): InboxShortcutId | undefined;
export function shortcutFor(
  event: KeyboardEvent,
  scope: ShortcutScope = "global",
): ShortcutId | undefined {
  if (event.altKey || event.shiftKey) return undefined;
  const mod = event.metaKey || event.ctrlKey;
  const table = scope === "inbox" ? INBOX_SHORTCUTS : SHORTCUTS;
  return table.find(
    (shortcut) => shortcut.mod === mod && shortcut.key === event.key.toLowerCase(),
  )?.id;
}

/** What App does with a matched shortcut. Open-project closes the palette first. */
export function runGlobalShortcut(
  id: GlobalShortcutId,
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

/**
 * True when the event came from xterm's helper textarea (or anything inside
 * `.xterm`). Duck-typed so the unit tests can run in node, without a DOM.
 */
export function isPtyTarget(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  const node = target as {
    className?: unknown;
    classList?: { contains?: (token: string) => boolean };
    closest?: (selector: string) => unknown;
  };
  if (node.classList?.contains?.("xterm-helper-textarea") === true) return true;
  if (
    typeof node.className === "string" &&
    node.className.split(/\s+/).includes("xterm-helper-textarea")
  ) {
    return true;
  }
  return typeof node.closest === "function" && node.closest(".xterm") != null;
}

/** True when the event target is the attention rail or a permission chip row. */
export function isInboxTarget(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  return typeof closest === "function" && closest.call(target, "[data-inbox-keys]") != null;
}

/** Session the focused inbox control is about, from `data-session-id`. */
export function inboxSessionId(target: EventTarget | null): string | undefined {
  if (target == null || typeof target !== "object") return undefined;
  const closest = (
    target as {
      closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null;
    }
  ).closest;
  if (typeof closest !== "function") return undefined;
  const id = closest.call(target, "[data-session-id]")?.getAttribute?.("data-session-id");
  if (id === undefined || id === null || id === "") return undefined;
  return id;
}

export interface InboxShortcutDeps {
  allowOnce: (sessionId: string) => void;
  deny: (sessionId: string) => void;
  openPane: (sessionId: string) => void;
  showGraph: (sessionId: string) => void;
}

/**
 * Runs an inbox key if the event is one, the inbox (not a PTY) has focus, and
 * the control names a session. Returns whether it handled the event. Never
 * preventDefault on a focused terminal.
 */
export function runInboxShortcut(event: KeyboardEvent, deps: InboxShortcutDeps): boolean {
  if (isPtyTarget(event.target)) return false;
  const id = shortcutFor(event, "inbox");
  if (id === undefined) return false;
  if (!isInboxTarget(event.target)) return false;
  const sessionId = inboxSessionId(event.target);
  if (sessionId === undefined) return false;
  event.preventDefault();
  if (id === "inbox-allow") deps.allowOnce(sessionId);
  else if (id === "inbox-deny") deps.deny(sessionId);
  else if (id === "inbox-open") deps.openPane(sessionId);
  else deps.showGraph(sessionId);
  return true;
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
