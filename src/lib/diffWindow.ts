/**
 * Caps how many diff lines mount at once. A 512 KiB lockfile would otherwise
 * become one React node per line and stall WKWebView.
 */

export const INITIAL_DIFF_LINES = 400;
export const MORE_DIFF_LINES = 400;

export function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

/** The first `limit` lines, and how many remain after that. */
export function windowLines(text: string, limit: number): { text: string; hidden: number } {
  if (limit < 1) return { text: "", hidden: lineCount(text) };
  const lines = text.split("\n");
  if (lines.length <= limit) return { text, hidden: 0 };
  return { text: lines.slice(0, limit).join("\n"), hidden: lines.length - limit };
}

/**
 * Whole hunks until `limit` lines are spoken for. A hunk that crosses the
 * limit is still shown in full so a follow-up can name it.
 */
export function windowHunks(
  prelude: string,
  hunks: readonly string[],
  limit: number,
): { prelude: string; hunks: string[]; hidden: number } {
  const preludeLines = lineCount(prelude);
  if (preludeLines >= limit) {
    const clipped = windowLines(prelude, limit);
    return {
      prelude: clipped.text,
      hunks: [],
      hidden: clipped.hidden + hunks.reduce((sum, hunk) => sum + lineCount(hunk), 0),
    };
  }

  let used = preludeLines;
  const shown: string[] = [];
  let hidden = 0;
  for (const hunk of hunks) {
    const count = lineCount(hunk);
    if (used >= limit) {
      hidden += count;
      continue;
    }
    shown.push(hunk);
    used += count;
  }
  return { prelude, hunks: shown, hidden };
}

export function growVisible(current: number, total: number): number {
  return Math.min(total, current + MORE_DIFF_LINES);
}
