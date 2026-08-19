import { describe, expect, it } from "vitest";

import { hunkPrompt, splitDiff } from "./diffPrompt";

const UNIFIED = `diff --git a/src/lib.rs b/src/lib.rs
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,4 @@
 fn main() {
+    println!("hi");
 }
@@ -10,2 +11,3 @@
     other();
+    extra();
`;

describe("splitDiff", () => {
  it("keeps the file header as prelude and splits on hunk marks", () => {
    const { prelude, hunks } = splitDiff(UNIFIED);

    expect(prelude).toContain("diff --git");
    expect(prelude).toContain("--- a/src/lib.rs");
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toContain('println!("hi")');
    expect(hunks[0]).not.toContain("extra()");
    expect(hunks[1]).toContain("extra()");
  });

  it("treats a body with no hunk headers as one hunk", () => {
    const { prelude, hunks } = splitDiff("+fn main() {}\n");

    expect(prelude).toBe("");
    expect(hunks).toEqual(["+fn main() {}\n"]);
  });

  it("returns nothing for an empty diff", () => {
    expect(splitDiff("")).toEqual({ prelude: "", hunks: [] });
  });
});

describe("hunkPrompt", () => {
  it("fences the hunk and names the file", () => {
    const text = hunkPrompt("src/lib.rs", "@@ -1 +1 @@\n-old\n+new", "");

    expect(text).toContain("Regarding `src/lib.rs`");
    expect(text).toContain("```diff");
    expect(text).toContain("+new");
    expect(text.trimEnd().endsWith("```")).toBe(true);
  });

  it("appends a sentence when there is one", () => {
    const text = hunkPrompt("a.rs", "@@ -1 +1 @@\n+x", "  keep the comment  ");

    expect(text).toContain("keep the comment");
    expect(text.endsWith("keep the comment")).toBe(true);
  });

  it("omits a blank sentence rather than sending an empty paragraph", () => {
    const text = hunkPrompt("a.rs", "@@ -1 +1 @@\n+x", "   \n");

    expect(text).not.toContain("\n\n\n");
    expect(text.endsWith("```")).toBe(true);
  });
});
