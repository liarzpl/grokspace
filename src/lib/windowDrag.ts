/**
 * Moving an Overlay window from the in-app title bar.
 *
 * Tauri's injected listener only starts a drag when the click *target itself*
 * has `data-tauri-drag-region`. Nested labels often do not, and without
 * `core:window:allow-start-dragging` even a marked target is refused. This
 * helper starts the drag whenever the event is inside a marked region, which
 * is what "grab the title bar" has to mean.
 */

const NO_DRAG = "button, a, input, textarea, select, [data-no-drag]";

/** Structural so tests can pass a fake without a DOM. */
export interface DragTarget {
  closest: (selector: string) => DragTarget | null;
  hasAttribute?: (name: string) => boolean;
}

export function isWindowDragTarget(target: DragTarget | EventTarget | null): boolean {
  const el = asDragTarget(target);
  if (el === null) return false;
  if (el.closest(NO_DRAG) !== null) return false;
  return el.closest("[data-tauri-drag-region]") !== null;
}

export function beginWindowDrag(
  event: { button: number; detail: number; target: DragTarget | EventTarget | null },
  startDragging: () => void | Promise<void>,
): void {
  // Primary button, first click: a double-click is maximize, not a drag.
  if (event.button !== 0 || event.detail !== 1) return;
  if (!isWindowDragTarget(event.target)) return;
  // Tauri's injected listener already starts a drag when the target itself is
  // marked; a second start_dragging call on the same mousedown is refused.
  const el = asDragTarget(event.target);
  if (el?.hasAttribute?.("data-tauri-drag-region")) return;
  void startDragging();
}

function asDragTarget(target: DragTarget | EventTarget | null): DragTarget | null {
  if (target === null || typeof target !== "object") return null;
  if (!("closest" in target) || typeof target.closest !== "function") return null;
  return target as DragTarget;
}
