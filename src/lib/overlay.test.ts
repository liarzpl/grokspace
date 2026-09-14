import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { optionDomId, subscribeOverlay, tabWrap } from "./overlay";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(src, rel), "utf8");
}

describe("tabWrap", () => {
  it("wraps forward from the last item to the first", () => {
    expect(tabWrap(3, 2, false)).toBe(0);
  });

  it("wraps backward from the first item to the last", () => {
    expect(tabWrap(3, 0, true)).toBe(2);
  });

  it("steps inside the list without wrapping", () => {
    expect(tabWrap(3, 1, false)).toBe(2);
    expect(tabWrap(3, 1, true)).toBe(0);
  });

  it("is -1 when there is nothing to focus", () => {
    expect(tabWrap(0, 0, false)).toBe(-1);
  });
});

describe("optionDomId", () => {
  it("is a valid HTML id derived from the command id", () => {
    expect(optionDomId("cmd", "open.project")).toBe("cmd-open-project");
    expect(optionDomId("cmd", "layout-2x2")).toBe("cmd-layout-2x2");
  });
});

describe("subscribeOverlay", () => {
  it("does nothing while disabled", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const close = vi.fn();

    const stop = subscribeOverlay(false, null, close, {
      target: { addEventListener: add, removeEventListener: remove },
    });
    stop();

    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("fires on Escape from the window, not from a focused input", () => {
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
    const stop = subscribeOverlay(true, null, close, { target });

    for (const handler of listeners) {
      handler({ key: "Escape", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    }
    expect(close).toHaveBeenCalledOnce();

    stop();
    expect(listeners.size).toBe(0);
  });
});

describe("A11Y-003 dialog markup", () => {
  it("marks both overlays modal and wires the palette as a combobox", () => {
    const palette = read("components/CommandPalette.tsx");
    expect(palette).toMatch(/aria-modal="true"/);
    expect(palette).toMatch(/subscribeOverlay/);
    expect(palette).toMatch(/role="combobox"/);
    expect(palette).toMatch(/aria-activedescendant/);
    expect(palette).toMatch(/listbox/);
    expect(palette).toMatch(/role="option"/);
    expect(palette).toMatch(/aria-label="Filter commands"/);

    const settings = read("components/SettingsPanel.tsx");
    expect(settings).toMatch(/aria-modal="true"/);
    expect(settings).toMatch(/subscribeOverlay/);
    expect(settings).toMatch(/aria-labelledby="settings-title"/);
    expect(settings).not.toMatch(/subscribeEscape/);
  });
});
