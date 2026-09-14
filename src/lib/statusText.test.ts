import { describe, expect, it } from "vitest";

import {
  graphNodeA11yLabel,
  graphStatusPhrase,
  nodeStatusLabel,
  paneA11yLabel,
  sessionChipA11yLabel,
  sessionStatusPhrase,
} from "./statusText";

describe("nodeStatusLabel", () => {
  it("names every node status in words", () => {
    expect(nodeStatusLabel("pending")).toBe("Pending");
    expect(nodeStatusLabel("running")).toBe("Running");
    expect(nodeStatusLabel("completed")).toBe("Completed");
    expect(nodeStatusLabel("failed")).toBe("Failed");
    expect(nodeStatusLabel("skipped")).toBe("Skipped");
  });
});

describe("graphNodeA11yLabel", () => {
  it("includes the status so the name is not the label alone", () => {
    expect(graphNodeA11yLabel({ label: "Draft", status: "running" })).toBe("Draft, Running");
    expect(graphNodeA11yLabel({ label: "Gate", status: "skipped" })).toBe("Gate, Skipped");
  });
});

describe("session chrome labels", () => {
  it("says running/stopped in the pane name", () => {
    expect(paneA11yLabel("Pane 1", "running")).toBe("Pane 1, running");
    expect(paneA11yLabel("Grok", "stopped")).toBe("Grok, stopped");
  });

  it("spells needs_input as words", () => {
    expect(sessionStatusPhrase("needs_input")).toBe("needs input");
  });

  it("names graph health next to process status on a chip", () => {
    expect(graphStatusPhrase(true, undefined)).toBe("graph unreadable");
    expect(graphStatusPhrase(false, "partial")).toBe("graph partial");
    expect(graphStatusPhrase(false, undefined)).toBe("no graph yet");
    expect(
      sessionChipA11yLabel("1 · Shell", "running", { error: false, status: undefined }),
    ).toBe("1 · Shell, running, no graph yet");
  });
});
