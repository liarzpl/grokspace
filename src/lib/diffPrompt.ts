/**
 * Turning a unified diff into a prompt an idle agent can act on.
 *
 * The panel colours by the first character of each line; this file is the other
 * half of that: which lines are one hunk, and how they are asked about.
 */

/** File headers (`---`, `+++`, `diff --git`) stay as context; `@@` starts a hunk. */
export function splitDiff(diff: string): { prelude: string; hunks: string[] } {
  const lines = diff.split("\n");
  const prelude: string[] = [];
  const hunks: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current !== null) hunks.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current !== null) current.push(line);
    else prelude.push(line);
  }
  if (current !== null) hunks.push(current.join("\n"));

  // An untracked file diffed against nothing can arrive without hunk headers.
  // The whole body is then the thing to send, rather than a prelude with no hunk.
  if (hunks.length === 0 && diff.trim() !== "") {
    return { prelude: "", hunks: [diff] };
  }
  return { prelude: prelude.join("\n"), hunks };
}

/**
 * One prompt: the file, the hunk as a fenced diff, and an optional sentence.
 * Empty sentences are omitted rather than sent as a blank paragraph.
 */
export function hunkPrompt(path: string, hunk: string, sentence: string): string {
  const fenced = `\`\`\`diff\n${hunk.replace(/\n+$/, "")}\n\`\`\``;
  const note = sentence.trim();
  if (note === "") return `Regarding \`${path}\`:\n\n${fenced}`;
  return `Regarding \`${path}\`:\n\n${fenced}\n\n${note}`;
}
