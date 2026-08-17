/**
 * Reading the design tokens back out of CSS.
 *
 * Most of the app takes colour through Tailwind classes, which is the easy case. Two
 * places cannot: xterm wants a theme object and React Flow wants props, both in
 * JavaScript. They used to keep their own hex literals with a comment saying they were
 * "kept in step" with `styles.css`, which is a promise rather than a mechanism — and it
 * was the thing that made theme switching a bigger job than the comment claimed.
 *
 * Read lazily, never at module load: the stylesheet has to be applied before
 * `getComputedStyle` can see a variable, and a module body runs too early for that.
 */

/** One token's value, or an empty string if the stylesheet has not been applied yet. */
export function token(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The chrome colours the graph canvas draws with. */
export function graphTheme() {
  return {
    node: {
      pending: token("--color-ink-faint"),
      running: token("--color-accent"),
      completed: token("--color-success"),
      failed: token("--color-danger"),
      skipped: token("--color-skipped"),
    },
    edge: token("--color-line-strong"),
    edgeLabel: token("--color-ink-muted"),
    edgeLabelBackground: token("--color-panel"),
    canvasDots: token("--color-line"),
    minimapBackground: token("--color-terminal"),
    minimapStroke: token("--color-canvas"),
    /** The minimap dims what is off-screen, so this one carries an alpha. */
    minimapMask: `${token("--color-canvas")}b3`,
  };
}

/** The theme object xterm takes, assembled from the same tokens. */
export function terminalTheme() {
  return {
    background: token("--color-terminal"),
    foreground: token("--color-ink"),
    cursor: token("--color-accent"),
    cursorAccent: token("--color-canvas"),
    selectionBackground: token("--color-terminal-selection"),
    black: token("--color-ansi-black"),
    red: token("--color-ansi-red"),
    green: token("--color-ansi-green"),
    yellow: token("--color-ansi-yellow"),
    blue: token("--color-ansi-blue"),
    magenta: token("--color-ansi-magenta"),
    cyan: token("--color-ansi-cyan"),
    white: token("--color-ansi-white"),
    brightBlack: token("--color-ansi-bright-black"),
    brightRed: token("--color-ansi-bright-red"),
    brightGreen: token("--color-ansi-bright-green"),
    brightYellow: token("--color-ansi-bright-yellow"),
    brightBlue: token("--color-ansi-bright-blue"),
    brightMagenta: token("--color-ansi-bright-magenta"),
    brightCyan: token("--color-ansi-bright-cyan"),
    brightWhite: token("--color-ansi-bright-white"),
  };
}
