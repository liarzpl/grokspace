import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * DEPS-008: in-range Cargo.lock floors. A silent downgrade of uuid or the
 * dialog plugin would not change Cargo.toml's caret, so the lock is the pin.
 */

const lock = readFileSync(join(import.meta.dirname, "..", "src-tauri", "Cargo.lock"), "utf8");

function packageVersion(name: string): [number, number, number] {
  const header = `name = "${name}"\nversion = "`;
  const start = lock.indexOf(header);
  if (start < 0) throw new Error(`${name} is missing from Cargo.lock`);
  const rest = lock.slice(start + header.length);
  const end = rest.indexOf('"');
  const [major, minor, patch] = rest.slice(0, end).split(".").map(Number);
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

function atLeast(
  [gotMajor, gotMinor, gotPatch]: [number, number, number],
  [wantMajor, wantMinor, wantPatch]: [number, number, number],
): boolean {
  if (gotMajor !== wantMajor) return gotMajor > wantMajor;
  if (gotMinor !== wantMinor) return gotMinor > wantMinor;
  return gotPatch >= wantPatch;
}

describe("Cargo.lock in-range patches (DEPS-008)", () => {
  it("pins uuid to at least 1.26.1", () => {
    expect(atLeast(packageVersion("uuid"), [1, 26, 1])).toBe(true);
  });

  it("pins tauri-plugin-dialog to at least 2.7.3", () => {
    expect(atLeast(packageVersion("tauri-plugin-dialog"), [2, 7, 3])).toBe(true);
  });
});
