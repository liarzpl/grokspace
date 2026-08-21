import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { api } from "./api";
import { terminalTheme } from "./theme";

/**
 * Terminals live here rather than in React state, keyed by session id.
 *
 * A pane that remounts (StrictMode in development does this on every mount, and
 * changing the layout does it in production) must not lose its scrollback or
 * register a second input handler. Each terminal owns a detached container that
 * is moved between hosts, so `open()` is only ever called once.
 */

const FONT_FAMILY = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';

interface PaneTerminal {
  readonly container: HTMLDivElement;
  readonly term: Terminal;
  readonly fit: FitAddon;
  opened: boolean;
  attached: boolean;
}

const terminals = new Map<string, PaneTerminal>();

/**
 * Tauri delivers small channel payloads inline as an `ArrayBuffer` and larger
 * ones through a fetch, so the shape is normalised rather than assumed.
 */
function toBytes(chunk: ArrayBuffer | ArrayBufferView | number[]): Uint8Array {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Uint8Array.from(chunk);
}

/**
 * xterm 6 removed the canvas renderer, leaving WebGL and DOM. WebGL construction
 * throws outright on machines without a usable GPU, so failure falls back to the
 * DOM renderer that is already in place.
 */
async function enableWebgl(term: Terminal): Promise<void> {
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    const addon = new WebglAddon();
    addon.onContextLoss(() => addon.dispose());
    term.loadAddon(addon);
  } catch {
    // Nothing to do: the DOM renderer is the supported fallback.
  }
}

export function acquireTerminal(sessionId: string): PaneTerminal {
  const existing = terminals.get(sessionId);
  if (existing) return existing;

  const container = document.createElement("div");
  container.style.height = "100%";
  container.style.width = "100%";

  const term = new Terminal({
    // Read from the stylesheet rather than kept in step with it by hand.
    theme: terminalTheme(),
    fontFamily: FONT_FAMILY,
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 10_000,
    macOptionIsMeta: true,
    drawBoldTextInBrightColors: true,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);

  // Registered once per session, not per mount, so a remounted pane does not
  // send every keystroke twice.
  term.onData((data) => {
    // Typing into a session that has already exited is expected; the exit event
    // is what tells the user about it, so the rejection is not worth surfacing.
    void api.writeSession(sessionId, data).catch(() => {});
  });

  const entry: PaneTerminal = { container, term, fit, opened: false, attached: false };
  terminals.set(sessionId, entry);
  return entry;
}

/** Moves the session's terminal into `host`, opening it the first time. */
export function mountTerminal(sessionId: string, host: HTMLElement): PaneTerminal {
  const entry = acquireTerminal(sessionId);
  const moved = entry.container.parentElement !== host;
  // One host, one session. Pane ids are reused across projects, so a leftover
  // container from the project being left would otherwise stay visible under the
  // arriving one.
  if (moved || host.childElementCount !== 1) {
    host.replaceChildren(entry.container);
  }

  if (!entry.opened) {
    entry.term.open(entry.container);
    entry.opened = true;
    // Must come after open(): the addon needs the terminal's canvas context.
    void enableWebgl(entry.term);
  } else if (moved) {
    // Re-attaching a container that had been detached - a tab switch, or a
    // layout change - leaves the renderer with nothing queued, so the pane reads
    // as blank until some later event happens to repaint it.
    entry.term.refresh(0, entry.term.rows - 1);
  }

  return entry;
}

/** Points the backend's output at this terminal. Safe to call more than once. */
export async function attachTerminal(sessionId: string): Promise<void> {
  const entry = acquireTerminal(sessionId);
  if (entry.attached) return;
  entry.attached = true;

  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (chunk) => entry.term.write(toBytes(chunk));

  try {
    await api.attachSession(sessionId, channel);
  } catch (error) {
    entry.attached = false;
    throw error;
  }
}

/**
 * Resizes the terminal to its host and returns the new grid, or null when the
 * pane is not measurable yet (hidden, or mid-layout).
 */
export function fitTerminal(sessionId: string): { cols: number; rows: number } | null {
  const entry = terminals.get(sessionId);
  if (!entry?.opened) return null;

  const proposed = entry.fit.proposeDimensions();
  if (!proposed || !(proposed.cols >= 1) || !(proposed.rows >= 1)) return null;

  entry.fit.fit();
  return { cols: entry.term.cols, rows: entry.term.rows };
}

export function clearTerminal(sessionId: string): void {
  terminals.get(sessionId)?.term.clear();
}

export function focusTerminal(sessionId: string): void {
  terminals.get(sessionId)?.term.focus();
}

/** Writes a line of GrokSpace's own text into the pane, dimmed to stand apart. */
export function writeNotice(sessionId: string, text: string): void {
  terminals.get(sessionId)?.term.writeln(`\r\n\x1b[2m${text}\x1b[0m`);
}

/**
 * Takes the terminal out of the DOM without destroying it. The pty is still
 * running, and attach() will replay into this instance when the pane comes back.
 */
export function detachTerminal(sessionId: string): void {
  terminals.get(sessionId)?.container.remove();
}

export function disposeTerminal(sessionId: string): void {
  const entry = terminals.get(sessionId);
  if (!entry) return;
  terminals.delete(sessionId);
  entry.term.dispose();
  entry.container.remove();
}
