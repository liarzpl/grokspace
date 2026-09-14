import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("TEST-010 coverage report", () => {
  it("publishes HTML for src/lib and src/stores without a fail-on-drop gate", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts["test:coverage"]).toMatch(/vitest run --coverage/);
    expect(pkg.devDependencies["@vitest/coverage-v8"]).toBeDefined();

    const vite = read("vite.config.ts");
    expect(vite).toMatch(/reporter:\s*\[[^\]]*["']html["']/s);
    expect(vite).toMatch(/["']src\/lib\/\*\*["']/);
    expect(vite).toMatch(/["']src\/stores\/\*\*["']/);
    expect(vite).not.toMatch(/^\s*thresholds\s*:/m);

    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/test:coverage/);
    expect(ci).toMatch(/vitest-coverage-html/);
    expect(ci).toMatch(/upload-artifact@[0-9a-f]{40}/);
    expect(ci).not.toMatch(/failOnDrop|fail-on-drop/);
  });
});
