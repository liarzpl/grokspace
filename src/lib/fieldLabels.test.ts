import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

/**
 * A11Y-007: every text field listed in the audit must have a stable accessible
 * name. Placeholders are not names. CommandPalette is owned by A11Y-003.
 */
describe("field labels (A11Y-007)", () => {
  it("names every task, memory, follow-up, step, hunk, and rename field", () => {
    const taskBoard = source("components/TaskBoard.tsx");
    expect(taskBoard).toMatch(/aria-label="Task title"/);
    expect(taskBoard).toMatch(/aria-label="Task description"/);

    const memory = source("components/MemoryPanel.tsx");
    expect(memory).toMatch(/aria-label="Memory key"/);
    expect(memory).toMatch(/aria-label="Memory content"/);
    expect(memory).toMatch(/aria-label=\{`Memory: \$\{entry\.key\}`\}/);

    const transcript = source("components/AgentTranscript.tsx");
    expect(transcript).toMatch(/aria-label=\{`Follow up to \$\{session\.title \?\? "agent"\}`\}/);

    const steps = source("components/SessionSteps.tsx");
    expect(steps).toMatch(/aria-label="Step title"/);

    const diff = source("components/DiffPanel.tsx");
    expect(diff).toMatch(/aria-label="Ask about this hunk"/);

    const sidebar = source("components/ProjectSidebar.tsx");
    expect(sidebar).toMatch(/aria-label=\{`Rename \$\{project\.name\}`\}/);

    const pane = source("components/TerminalPane.tsx");
    expect(pane).toMatch(/aria-label=\{`Rename \$\{session\.title/);
  });
});
