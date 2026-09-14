import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FALLBACK_TOKENS } from "./theme";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(src, rel), "utf8");
}

/** Hex declarations inside the `@theme` block — the only palette that should exist. */
function themeHexes(css: string): Record<string, string> {
  const start = css.indexOf("@theme");
  if (start < 0) throw new Error("missing @theme");
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("unclosed @theme");

  const out: Record<string, string> = {};
  const block = css.slice(open + 1, end);
  for (const match of block.matchAll(/(--color-[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    out[name] = value.toLowerCase();
  }
  return out;
}

function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const h = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw.slice(0, 6);
  const channel = (offset: number) => {
    const n = parseInt(h.slice(offset, offset + 2), 16) / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

describe("FALLBACK_TOKENS", () => {
  it("matches the hex values declared in @theme, so ErrorBoundary cannot drift", () => {
    const hexes = themeHexes(read("styles.css"));
    for (const [name, value] of Object.entries(FALLBACK_TOKENS)) {
      expect(hexes[name], name).toBe(value.toLowerCase());
    }
  });
});

describe("A11Y-004 ink-faint contrast", () => {
  it("is at least 4.5:1 on canvas, panel, and elevated", () => {
    const hexes = themeHexes(read("styles.css"));
    const faint = hexes["--color-ink-faint"];
    expect(faint).toBeDefined();
    for (const bg of ["--color-canvas", "--color-panel", "--color-elevated"] as const) {
      const surface = hexes[bg];
      expect(surface, bg).toBeDefined();
      expect(contrast(faint!, surface!), `${faint} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("STYLE-003 token call sites", () => {
  it("does not keep a parallel Tailwind or hex palette", () => {
    const node = read("components/graph/GraphNode.tsx");
    expect(node).not.toMatch(/text-cyan-300|text-fuchsia-300|text-indigo-300/);
    expect(node).not.toMatch(/\bopacity-\d+\b/);
    expect(node).toMatch(/text-ansi-cyan/);
    expect(node).toMatch(/text-ansi-magenta/);
    expect(node).toMatch(/text-ansi-bright-blue/);

    // Leftover StatusDot already uses tokens; lock that map instead of the old pane hex.
    const tone = read("lib/statusTone.ts");
    expect(tone).not.toMatch(/bg-green-400/);
    expect(tone).toMatch(/bg-success/);

    const boundary = read("components/ErrorBoundary.tsx");
    expect(boundary).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(boundary).toMatch(/paint\(/);

    const css = read("styles.css");
    const pulse = css.slice(css.indexOf("@keyframes node-pulse"));
    expect(pulse).not.toMatch(/#6d8cff/);
    expect(pulse).toMatch(/var\(--color-accent-pulse\)/);
  });
});
