import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(src, rel), "utf8");
}

describe("A11Y-002 focus ring", () => {
  it("draws a token outline on :focus-visible", () => {
    const css = read("styles.css");
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-accent\)/s);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px/s);
  });

  it("does not strip the ring from the palette search field", () => {
    const palette = read("components/CommandPalette.tsx");
    expect(palette).not.toMatch(/focus:outline-none/);
    expect(palette).toMatch(/focus:border-accent/);
  });
});
