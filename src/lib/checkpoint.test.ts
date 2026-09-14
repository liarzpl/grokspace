import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CHECKPOINT_EQUALS_HEAD, DISCARD_REVERTS_CHECKPOINT } from "./checkpoint";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

describe("checkpoint copy", () => {
  it("names HEAD as the checkpoint and Discard as revert", () => {
    expect(CHECKPOINT_EQUALS_HEAD).toBe("Checkpoint = this worktree's HEAD");
    expect(DISCARD_REVERTS_CHECKPOINT).toBe("Discard reverts this checkpoint");
  });

  it("is the copy Diff and Close chrome import", () => {
    const diff = source("components/DiffPanel.tsx");
    expect(diff).toMatch(/CHECKPOINT_EQUALS_HEAD/);
    expect(diff).toMatch(/DISCARD_REVERTS_CHECKPOINT/);

    const shell = source("components/WorkspaceShell.tsx");
    expect(shell).toMatch(/CHECKPOINT_EQUALS_HEAD/);
    expect(shell).toMatch(/DISCARD_REVERTS_CHECKPOINT/);
  });

  it("is copy only — no git invoke or snapshot store", () => {
    const lib = source("lib/checkpoint.ts");
    expect(lib).toMatch(/^export const CHECKPOINT_EQUALS_HEAD = /m);
    expect(lib).toMatch(/^export const DISCARD_REVERTS_CHECKPOINT = /m);
    expect(lib).not.toMatch(/invoke\(|Command::|new_command|createTable|INSERT INTO/i);
  });
});
