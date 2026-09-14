// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { graphTheme, terminalTheme, token } from "./theme";

const cssPath = join(import.meta.dirname, "..", "styles.css");

/** Colour declarations inside the `@theme` block — the stylesheet `theme.ts` reads. */
function themeColorTokens(css: string): Record<string, string> {
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
  for (const match of block.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2]?.trim();
    if (name === undefined || value === undefined) continue;
    out[name] = value;
  }
  return out;
}

function applyStylesheet(tokens: Record<string, string>): void {
  const style = document.createElement("style");
  style.dataset.themeFixture = "1";
  style.textContent = `:root {\n${Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n")}\n}`;
  document.head.appendChild(style);
  // jsdom exposes custom properties on getComputedStyle when they are set on the
  // element. The <style> tag is the sheet under test; this is what makes
  // `token()` see it the same way a real document would after Tailwind applies
  // `@theme`.
  for (const [name, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(name, value);
  }
}

afterEach(() => {
  document.querySelectorAll("style[data-theme-fixture]").forEach((el) => {
    el.remove();
  });
  document.documentElement.removeAttribute("style");
});

describe("theme.ts against an applied stylesheet", () => {
  it("returns an empty string before any token is applied", () => {
    expect(token("--color-danger")).toBe("");
    expect(graphTheme().node.failed).toBe("");
  });

  it("reads graphTheme().node.failed from the danger token", () => {
    const tokens = themeColorTokens(readFileSync(cssPath, "utf8"));
    const danger = tokens["--color-danger"];
    expect(danger, "--color-danger must exist in @theme").toBeTruthy();
    applyStylesheet(tokens);

    expect(graphTheme().node.failed).toBe(danger);
    expect(graphTheme().node.failed).toBe(token("--color-danger"));
  });

  it("maps the rest of graphTheme and terminalTheme from the same sheet", () => {
    const tokens = themeColorTokens(readFileSync(cssPath, "utf8"));
    applyStylesheet(tokens);

    const graph = graphTheme();
    expect(graph.node.pending).toBe(token("--color-ink-faint"));
    expect(graph.node.running).toBe(token("--color-accent"));
    expect(graph.node.completed).toBe(token("--color-success"));
    expect(graph.node.skipped).toBe(token("--color-skipped"));
    expect(graph.edge).toBe(token("--color-line-strong"));
    expect(graph.minimapMask).toBe(`${token("--color-canvas")}b3`);

    const term = terminalTheme();
    expect(term.background).toBe(token("--color-terminal"));
    expect(term.foreground).toBe(token("--color-ink"));
    expect(term.cursor).toBe(token("--color-accent"));
    expect(term.red).toBe(token("--color-ansi-red"));
  });
});
