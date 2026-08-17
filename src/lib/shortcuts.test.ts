import { describe, expect, it } from "vitest";

import { SHORTCUTS, shortcutFor, shortcutLabel } from "./shortcuts";

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
