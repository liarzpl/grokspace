import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * RTL only auto-cleans when Vitest globals are on. This repo does not turn
 * them on, so a leftover tree would make the next `getByTestId` find two.
 */
afterEach(() => {
  cleanup();
});

/**
 * TerminalPane observes its host. jsdom grew a ResizeObserver, but a missing
 * one would throw the moment a pane mounts, which is not the failure we want.
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// Palette arrows call this to keep the highlighted row in view. jsdom has no layout.
if (typeof Element !== "undefined" && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
