import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { EVENT_NAMES } from "./events";

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

function captured(source: string, pattern: RegExp): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function invokeNames(source: string): string[] {
  return captured(source, /invoke(?:<[^>]+>)?\(\s*"([a-z0-9_]+)"/g);
}

function handlerNames(source: string): string[] {
  const block = source.match(/generate_handler!\[([\s\S]*?)\]/);
  const body = block?.[1];
  if (body === undefined) return [];
  return captured(body, /\w+::(\w+)/g);
}

function rustEventNames(source: string): string[] {
  return captured(source, /const \w+_EVENT: &str = "([^"]+)"/g);
}

describe("IPC contract", () => {
  it("keeps api.ts invoke names equal to generate_handler! commands", () => {
    const frontend = new Set(invokeNames(read("src/lib/api.ts")));
    const backend = new Set(handlerNames(read("src-tauri/src/lib.rs")));

    expect([...frontend].sort()).toEqual([...backend].sort());
  });

  it("keeps events.ts names equal to the Rust event constants", () => {
    const rust = [
      ...rustEventNames(read("src-tauri/src/session/start.rs")),
      ...rustEventNames(read("src-tauri/src/graph.rs")),
      ...rustEventNames(read("src-tauri/src/steps/watch.rs")),
      ...rustEventNames(read("src-tauri/src/task.rs")),
    ];

    expect([...EVENT_NAMES].sort()).toEqual([...new Set(rust)].sort());
  });
});
