import { describe, expect, it } from "vitest";

import { homeRelative } from "./paths";

describe("homeRelative", () => {
  it.each([
    ["/Users/ada", "~"],
    ["/Users/ada/", "~/"],
    ["/Users/ada/src", "~/src"],
    ["/Users/ada/Documents/projects/grokspace", "~/Documents/projects/grokspace"],
    ["/home/ada", "~"],
    ["/home/ada/src/lib/paths.ts", "~/src/lib/paths.ts"],
  ])("shortens %s the way a shell prompt would", (path, shown) => {
    expect(homeRelative(path)).toBe(shown);
  });

  it.each([
    "/opt/homebrew",
    "/Users",
    "/home",
    "/home/",
    "C:/Users/ada/src",
    "src/lib/paths.ts",
    "",
  ])("leaves %s alone when it is not a Unix home path", (path) => {
    expect(homeRelative(path)).toBe(path);
  });
});
