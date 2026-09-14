import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adjacentIndex, moveSegmented } from "./segmented";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

describe("adjacentIndex", () => {
  it("wraps on arrows and jumps on Home/End", () => {
    expect(adjacentIndex(0, "ArrowRight", 3)).toBe(1);
    expect(adjacentIndex(2, "ArrowRight", 3)).toBe(0);
    expect(adjacentIndex(0, "ArrowLeft", 3)).toBe(2);
    expect(adjacentIndex(1, "Home", 3)).toBe(0);
    expect(adjacentIndex(1, "End", 3)).toBe(2);
  });

  it("ignores unrelated keys and an empty group", () => {
    expect(adjacentIndex(0, "Enter", 3)).toBeNull();
    expect(adjacentIndex(0, "ArrowRight", 0)).toBeNull();
  });
});

describe("moveSegmented", () => {
  it("chooses the next option and focuses it", () => {
    const chosen: string[] = [];
    const focused: string[] = [];
    const original = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: (id: string) => {
          focused.push(id);
          return { focus() {} };
        },
      },
    });

    try {
      moveSegmented(
        { key: "ArrowRight", preventDefault() {} },
        ["a", "b", "c"],
        "a",
        (option) => chosen.push(option),
        (option) => `seg-${option}`,
      );
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: original,
      });
    }

    expect(chosen).toEqual(["b"]);
    expect(focused).toEqual(["seg-b"]);
  });
});

/**
 * A11Y-006: selected state is programmatic, not only `bg-accent-soft`.
 */
describe("segmented selected state (A11Y-006)", () => {
  it("exposes workspace tabs as a tablist and the rest as radios or pressed", () => {
    const shell = source("components/WorkspaceShell.tsx");
    expect(shell).toMatch(/role="tablist"/);
    expect(shell).toMatch(/role="tab"/);
    expect(shell).toMatch(/aria-selected=\{active\}/);
    expect(shell).toMatch(/role="tabpanel"/);
    expect(shell).toMatch(/aria-pressed=\{active\}/);

    // Leftover DEBT-014 moved Choice out of SettingsPanel into ui.tsx.
    const choice = source("components/ui.tsx");
    expect(choice).toMatch(/role="radiogroup"/);
    expect(choice).toMatch(/aria-checked=\{option === value\}/);

    const panes = source("components/PaneGrid.tsx");
    expect(panes).toMatch(/role="radiogroup"/);
    expect(panes).toMatch(/aria-checked=\{layout === active\}/);

    const terminal = source("components/TerminalPane.tsx");
    expect(terminal).toMatch(/role="radiogroup"/);
    expect(terminal).toMatch(/aria-checked=\{view === option\}/);

    const memory = source("components/MemoryPanel.tsx");
    expect(memory).toMatch(/role="radiogroup"/);
    expect(memory).toMatch(/aria-checked=\{candidate === type\}/);

    const tasks = source("components/TaskBoard.tsx");
    expect(tasks).toMatch(/aria-pressed=\{chosen\.includes\(role\.name\)\}/);

    const diff = source("components/DiffPanel.tsx");
    expect(diff).toMatch(/role="radiogroup"/);
    expect(diff).toMatch(/aria-checked=\{scope === null\}/);

    const steps = source("components/SessionSteps.tsx");
    expect(steps).toMatch(/role="radiogroup"/);
    expect(steps).toMatch(/aria-checked=\{session\.id === selected\?\.id\}/);
  });
});
