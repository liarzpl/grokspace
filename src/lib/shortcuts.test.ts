import { describe, expect, it, vi } from "vitest";

import {
  SHORTCUTS,
  runGlobalShortcut,
  shortcutFor,
  shortcutLabel,
  subscribeEscape,
} from "./shortcuts";

/** Enough of a KeyboardEvent for matching, which reads four fields. */
function press(key: string, held: Partial<Record<"meta" | "ctrl" | "alt" | "shift", true>> = {}) {
  return {
    key,
    metaKey: held.meta ?? false,
    ctrlKey: held.ctrl ?? false,
    altKey: held.alt ?? false,
    shiftKey: held.shift ?? false,
  } as KeyboardEvent;
}

describe("the shortcut table", () => {
  it("gives every shortcut a distinct combination", () => {
    // Two shortcuts on one key means one of them silently never fires.
    const combos = SHORTCUTS.map((shortcut) => `${shortcut.mod ? "mod+" : ""}${shortcut.key}`);
    expect(new Set(combos).size).toBe(SHORTCUTS.length);
  });

  it("declares keys lower-cased, since that is what matching compares", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.key).toBe(shortcut.key.toLowerCase());
    }
  });

  it("says what each one does", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.label.length, `${shortcut.id} needs a label`).toBeGreaterThan(8);
    }
  });
});

describe("shortcutFor", () => {
  it("accepts either modifier, the way the original Cmd+O did", () => {
    expect(shortcutFor(press("k", { meta: true }))).toBe("command-palette");
    expect(shortcutFor(press("k", { ctrl: true }))).toBe("command-palette");
    expect(shortcutFor(press("o", { meta: true }))).toBe("open-project");
  });

  it("ignores the key without its modifier", () => {
    // Otherwise typing "k" anywhere would open the palette.
    expect(shortcutFor(press("k"))).toBeUndefined();
  });

  it("ignores anything with Alt or Shift held", () => {
    // Those are how a terminal sends characters this app has no business taking.
    expect(shortcutFor(press("k", { meta: true, alt: true }))).toBeUndefined();
    expect(shortcutFor(press("k", { meta: true, shift: true }))).toBeUndefined();
  });

  it("is case-insensitive about the key it was given", () => {
    expect(shortcutFor(press("K", { meta: true }))).toBe("command-palette");
  });

  it("says nothing for a combination it does not know", () => {
    expect(shortcutFor(press("j", { meta: true }))).toBeUndefined();
  });
});

describe("shortcutLabel", () => {
  it("writes the modifier the way the platform does", () => {
    expect(shortcutLabel("command-palette", true)).toBe("⌘K");
    expect(shortcutLabel("command-palette", false)).toBe("Ctrl+K");
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
