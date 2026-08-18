import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beginWindowDrag, isWindowDragTarget, type DragTarget } from "./windowDrag";

function el(kind: "nested" | "marked" | "button" | "outside"): DragTarget {
  return {
    hasAttribute: (name) => kind === "marked" && name === "data-tauri-drag-region",
    closest: (selector: string) => {
      if (selector.startsWith("button") && kind === "button") return el("button");
      if (selector.includes("data-tauri-drag-region") && (kind === "nested" || kind === "marked")) {
        return el(kind);
      }
      return null;
    },
  };
}

describe("isWindowDragTarget", () => {
  it("accepts a click inside a marked title-bar region", () => {
    expect(isWindowDragTarget(el("nested"))).toBe(true);
    expect(isWindowDragTarget(el("marked"))).toBe(true);
  });

  it("refuses buttons and anything outside the bar", () => {
    expect(isWindowDragTarget(el("button"))).toBe(false);
    expect(isWindowDragTarget(el("outside"))).toBe(false);
    expect(isWindowDragTarget(null)).toBe(false);
  });
});

describe("beginWindowDrag", () => {
  it("starts a drag when the click landed on an unmarked descendant of the bar", () => {
    const startDragging = vi.fn();
    beginWindowDrag({ button: 0, detail: 1, target: el("nested") }, startDragging);
    expect(startDragging).toHaveBeenCalledOnce();
  });

  it("leaves a marked target to Tauri's injected listener, so start_dragging is not sent twice", () => {
    const startDragging = vi.fn();
    beginWindowDrag({ button: 0, detail: 1, target: el("marked") }, startDragging);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("does not drag on double-click, which is maximize", () => {
    const startDragging = vi.fn();
    beginWindowDrag({ button: 0, detail: 2, target: el("nested") }, startDragging);
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("does not drag from a control", () => {
    const startDragging = vi.fn();
    beginWindowDrag({ button: 0, detail: 1, target: el("button") }, startDragging);
    expect(startDragging).not.toHaveBeenCalled();
  });
});

describe("the Overlay window capability", () => {
  it("allows start-dragging, without which the title bar cannot move the window", () => {
    const capPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../src-tauri/capabilities/default.json",
    );
    const cap = JSON.parse(readFileSync(capPath, "utf8")) as { permissions: string[] };
    expect(cap.permissions).toContain("core:window:allow-start-dragging");
  });
});
