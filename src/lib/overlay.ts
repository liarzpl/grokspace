/**
 * Shared behaviour for the two overlays (palette and settings).
 *
 * There is no dialog library. Escape, Tab wrapping, and restoring focus used to
 * be written twice and only half-applied — settings had Escape on the window,
 * the palette only had it on the search field, and neither trapped Tab.
 */

import type { KeyTarget } from "./shortcuts";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Which index receives focus after Tab. `-1` when the trap is empty. */
export function tabWrap(count: number, current: number, shift: boolean): number {
  if (count === 0) return -1;
  if (shift) return current <= 0 ? count - 1 : current - 1;
  return current >= count - 1 ? 0 : current + 1;
}

/** A stable HTML id for `aria-activedescendant`, derived from a command id. */
export function optionDomId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function focusableIn(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    return el.getClientRects().length > 0;
  });
}

/**
 * Window-level Escape, a Tab trap inside `root`, and focus restore on close.
 *
 * `initialFocus: "container"` is for settings (no autofocus). The palette
 * leaves the default so the search field — already `autoFocus` — stays first.
 */
export function subscribeOverlay(
  enabled: boolean,
  root: HTMLElement | null,
  onClose: () => void,
  options: {
    initialFocus?: "first" | "container";
    target?: KeyTarget;
  } = {},
): () => void {
  const target: KeyTarget | undefined =
    options.target ?? (typeof window === "undefined" ? undefined : window);
  if (!enabled || target === undefined) return () => {};

  const prior =
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  if (root !== null) {
    if (options.initialFocus === "container") {
      root.focus();
    } else {
      const first = focusableIn(root)[0];
      (first ?? root).focus();
    }
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    if (root === null) {
      event.preventDefault();
      return;
    }
    const items = focusableIn(root);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const active = typeof document !== "undefined" ? document.activeElement : null;
    const current = items.findIndex((el) => el === active);
    const wrapping =
      current === -1 ||
      (event.shiftKey && current === 0) ||
      (!event.shiftKey && current === items.length - 1);
    if (!wrapping) return;
    const next = tabWrap(items.length, current === -1 ? (event.shiftKey ? 0 : items.length - 1) : current, event.shiftKey);
    if (next === -1) return;
    event.preventDefault();
    items[next]?.focus();
  };

  target.addEventListener("keydown", onKey);
  return () => {
    target.removeEventListener("keydown", onKey);
    prior?.focus();
  };
}
