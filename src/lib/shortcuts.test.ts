import { describe, expect, it, vi } from "vitest";

import {
  INBOX_SHORTCUTS,
  SHORTCUTS,
  inboxSessionId,
  isInboxTarget,
  isPtyTarget,
  runGlobalShortcut,
  runInboxShortcut,
  shortcutFor,
  shortcutLabel,
  subscribeEscape,
} from "./shortcuts";

/** Enough of a KeyboardEvent for matching, which reads four fields. */
function press(
  key: string,
  held: Partial<Record<"meta" | "ctrl" | "alt" | "shift", true>> = {},
  target: EventTarget | null = null,
) {
  return {
    key,
    metaKey: held.meta ?? false,
    ctrlKey: held.ctrl ?? false,
    altKey: held.alt ?? false,
    shiftKey: held.shift ?? false,
    target,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

function inboxTarget(sessionId = "s1"): EventTarget {
  return {
    closest: (selector: string) => {
      if (selector === "[data-inbox-keys]" || selector === "[data-session-id]") {
        return { getAttribute: (name: string) => (name === "data-session-id" ? sessionId : "") };
      }
      return null;
    },
  } as unknown as EventTarget;
}

function ptyTarget(): EventTarget {
  return {
    classList: { contains: (token: string) => token === "xterm-helper-textarea" },
    closest: () => null,
  } as unknown as EventTarget;
}

describe("the shortcut table", () => {
  it("gives every shortcut a distinct combination", () => {
    // Two shortcuts on one key means one of them silently never fires.
    const combos = SHORTCUTS.map((shortcut) => `${shortcut.mod ? "mod+" : ""}${shortcut.key}`);
    expect(new Set(combos).size).toBe(SHORTCUTS.length);
  });

  it("declares keys lower-cased, since that is what matching compares", () => {
    for (const shortcut of [...SHORTCUTS, ...INBOX_SHORTCUTS]) {
      expect(shortcut.key).toBe(shortcut.key.toLowerCase());
    }
  });

  it("says what each one does", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.label.length, `${shortcut.id} needs a label`).toBeGreaterThan(8);
    }
  });

  it("keeps inbox triage out of the global table, so grok TUI keeps those keys", () => {
    expect(SHORTCUTS.map((shortcut) => shortcut.id)).toEqual(["command-palette", "open-project"]);
    expect(INBOX_SHORTCUTS.every((shortcut) => shortcut.mod === false)).toBe(true);
  });
});

describe("shortcutFor", () => {
  it.each([
    { key: "k", held: { meta: true } as const, scope: "global" as const, want: "command-palette" },
    { key: "k", held: { ctrl: true } as const, scope: "global" as const, want: "command-palette" },
    { key: "o", held: { meta: true } as const, scope: "global" as const, want: "open-project" },
    { key: "k", held: {}, scope: "global" as const, want: undefined },
    { key: "k", held: { meta: true, alt: true } as const, scope: "global" as const, want: undefined },
    { key: "k", held: { meta: true, shift: true } as const, scope: "global" as const, want: undefined },
    { key: "j", held: { meta: true } as const, scope: "global" as const, want: undefined },
    { key: "a", held: {}, scope: "inbox" as const, want: "inbox-allow" },
    { key: "d", held: {}, scope: "inbox" as const, want: "inbox-deny" },
    { key: "o", held: {}, scope: "inbox" as const, want: "inbox-open" },
    { key: "g", held: {}, scope: "inbox" as const, want: "inbox-graph" },
    { key: "A", held: {}, scope: "inbox" as const, want: "inbox-allow" },
    { key: "a", held: {}, scope: "global" as const, want: undefined },
    { key: "o", held: {}, scope: "global" as const, want: undefined },
    { key: "k", held: { meta: true } as const, scope: "inbox" as const, want: undefined },
    { key: "a", held: { meta: true } as const, scope: "inbox" as const, want: undefined },
    { key: "d", held: { shift: true } as const, scope: "inbox" as const, want: undefined },
  ])("$key $scope → $want", ({ key, held, scope, want }) => {
    const id =
      scope === "inbox" ? shortcutFor(press(key, held), "inbox") : shortcutFor(press(key, held));
    expect(id).toBe(want);
  });
});

describe("shortcutLabel", () => {
  it("writes the modifier the way the platform does", () => {
    expect(shortcutLabel("command-palette", true)).toBe("⌘K");
    expect(shortcutLabel("command-palette", false)).toBe("Ctrl+K");
  });

  it("writes inbox keys without a modifier", () => {
    expect(shortcutLabel("inbox-allow")).toBe("A");
    expect(shortcutLabel("inbox-open")).toBe("O");
  });

  it("is empty for an id that is not in the table", () => {
    // Rather than throwing: a label is decoration, and a missing one must not take
    // a panel down with it.
    expect(shortcutLabel("nonesuch" as never, true)).toBe("");
  });
});

describe("runGlobalShortcut", () => {
  it("closes the palette before opening a project, so Cmd+O is not buried", () => {
    const closePalette = vi.fn();
    const togglePalette = vi.fn();
    const openProject = vi.fn();

    runGlobalShortcut("open-project", { closePalette, togglePalette, openProject });

    expect(closePalette).toHaveBeenCalledOnce();
    expect(openProject).toHaveBeenCalledOnce();
    expect(togglePalette).not.toHaveBeenCalled();
  });

  it("toggles the palette for its own shortcut", () => {
    const closePalette = vi.fn();
    const togglePalette = vi.fn();
    const openProject = vi.fn();

    runGlobalShortcut("command-palette", { closePalette, togglePalette, openProject });

    expect(togglePalette).toHaveBeenCalledOnce();
    expect(openProject).not.toHaveBeenCalled();
  });
});

describe("runInboxShortcut", () => {
  const deps = () => ({
    allowOnce: vi.fn(),
    deny: vi.fn(),
    openPane: vi.fn(),
    showGraph: vi.fn(),
  });

  it.each([
    { key: "a", method: "allowOnce" as const },
    { key: "d", method: "deny" as const },
    { key: "o", method: "openPane" as const },
    { key: "g", method: "showGraph" as const },
  ])("runs $method for $key when the inbox is focused", ({ key, method }) => {
    const handlers = deps();
    const event = press(key, {}, inboxTarget("wait"));

    expect(runInboxShortcut(event, handlers)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(handlers[method]).toHaveBeenCalledOnce();
    expect(handlers[method]).toHaveBeenCalledWith("wait");
  });

  it("ignores an xterm-focused event, so the grok TUI keeps the key", () => {
    const handlers = deps();
    const event = press("a", {}, ptyTarget());

    expect(isPtyTarget(event.target)).toBe(true);
    expect(runInboxShortcut(event, handlers)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(handlers.allowOnce).not.toHaveBeenCalled();
  });

  it("does not steal the key when the inbox is not focused", () => {
    const handlers = deps();
    const event = press("a", {}, { closest: () => null } as unknown as EventTarget);

    expect(isInboxTarget(event.target)).toBe(false);
    expect(runInboxShortcut(event, handlers)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(handlers.allowOnce).not.toHaveBeenCalled();
  });

  it("reads the session from data-session-id", () => {
    expect(inboxSessionId(inboxTarget("rev"))).toBe("rev");
    expect(inboxSessionId(ptyTarget())).toBeUndefined();
  });
});

describe("subscribeEscape", () => {
  it("does nothing while disabled", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const close = vi.fn();

    const stop = subscribeEscape(false, close, { addEventListener: add, removeEventListener: remove });
    stop();

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("fires on Escape and unsubscribes", () => {
    const listeners = new Set<(event: KeyboardEvent) => void>();
    const target = {
      addEventListener: (_type: "keydown", handler: (event: KeyboardEvent) => void) => {
        listeners.add(handler);
      },
      removeEventListener: (_type: "keydown", handler: (event: KeyboardEvent) => void) => {
        listeners.delete(handler);
      },
    };
    const close = vi.fn();
    const stop = subscribeEscape(true, close, target);

    for (const handler of listeners) {
      handler({ key: "Escape", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    }
    expect(close).toHaveBeenCalledOnce();

    stop();
    expect(listeners.size).toBe(0);
  });
});
