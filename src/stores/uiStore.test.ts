import { beforeEach, describe, expect, it } from "vitest";

import { WORKSPACE_TABS } from "../types";
import { TABS, useUiStore } from "./uiStore";

const initial = useUiStore.getState();

beforeEach(() => {
  useUiStore.setState(initial, true);
});

describe("TABS", () => {
  it("is a label map over WorkspaceTab, so openingTab cannot name a sixth panel", () => {
    expect(TABS.map((tab) => tab.id)).toEqual([...WORKSPACE_TABS]);
  });
});


describe("applyOpeningTab", () => {
  it("applies the preference while the workspace is still on Terminals", () => {
    useUiStore.getState().applyOpeningTab("graph");

    expect(useUiStore.getState().tab).toBe("graph");
  });

  it("does not yank a tab the user already picked", () => {
    useUiStore.getState().setTab("tasks");

    useUiStore.getState().applyOpeningTab("graph");

    expect(useUiStore.getState().tab).toBe("tasks");
  });

  it("is a no-op when the preference is already the default", () => {
    useUiStore.getState().applyOpeningTab("terminals");

    expect(useUiStore.getState().tab).toBe("terminals");
    expect(useUiStore.getState().isPaletteOpen).toBe(false);
  });
});

describe("pane chrome", () => {
  it("switches one pane to its steps face without touching the others", () => {
    useUiStore.getState().setPaneView("1", "steps");

    const { paneViews } = useUiStore.getState();
    expect(paneViews["1"]).toBe("steps");
    expect(paneViews["0"]).toBeUndefined();
  });

  it("expands a pane and restores it on a second toggle", () => {
    useUiStore.getState().toggleMaximized("2");
    expect(useUiStore.getState().maximizedPane).toBe("2");

    useUiStore.getState().toggleMaximized("2");
    expect(useUiStore.getState().maximizedPane).toBeNull();
  });

  it("resetPaneChrome drops faces and the maximised pane together", () => {
    useUiStore.getState().setPaneView("1", "graph");
    useUiStore.getState().toggleMaximized("1");
    useUiStore.getState().selectGraph("s1");

    useUiStore.getState().resetPaneChrome();

    expect(useUiStore.getState().paneViews).toEqual({});
    expect(useUiStore.getState().maximizedPane).toBeNull();
    expect(useUiStore.getState().graphSessionId).toBeNull();
  });
});

describe("togglePalette", () => {
  it("closes settings when the palette opens, so the two overlays cannot stack", () => {
    useUiStore.setState({ isSettingsOpen: true, isPaletteOpen: false });

    useUiStore.getState().togglePalette();

    expect(useUiStore.getState().isPaletteOpen).toBe(true);
    expect(useUiStore.getState().isSettingsOpen).toBe(false);
  });

  it("leaves settings closed when the palette closes", () => {
    useUiStore.setState({ isSettingsOpen: false, isPaletteOpen: true });

    useUiStore.getState().togglePalette();

    expect(useUiStore.getState().isPaletteOpen).toBe(false);
    expect(useUiStore.getState().isSettingsOpen).toBe(false);
  });
});

describe("transcript and permissions", () => {
  it("folds consecutive message chunks into one line", () => {
    useUiStore.getState().appendTranscript("s1", { kind: "message", text: "Hel" });
    useUiStore.getState().appendTranscript("s1", { kind: "message", text: "lo" });

    expect(useUiStore.getState().transcript["s1"]).toEqual([{ kind: "message", text: "Hello" }]);
  });

  it("upserts a permission without stacking the same requestId", () => {
    useUiStore.getState().upsertPermission("s1", { requestId: 9, summary: "a" });
    useUiStore.getState().upsertPermission("s1", { requestId: 9, summary: "b" });
    useUiStore.getState().upsertPermission("s1", { requestId: 10, summary: "c" });

    expect(useUiStore.getState().permissions["s1"]).toEqual([
      { requestId: 9, summary: "b" },
      { requestId: 10, summary: "c" },
    ]);
  });

  it("keepTranscript drops ids that are not in the keep set", () => {
    useUiStore.getState().appendTranscript("s1", { kind: "message", text: "keep" });
    useUiStore.getState().appendTranscript("s2", { kind: "message", text: "gone" });
    useUiStore.getState().keepTranscript(new Set(["s1"]));

    expect(useUiStore.getState().transcript).toEqual({
      s1: [{ kind: "message", text: "keep" }],
    });
  });

  it("resetPaneChrome does not blank a live transcript", () => {
    useUiStore.getState().appendTranscript("s1", { kind: "message", text: "hi" });
    useUiStore.getState().replacePermissions({ s1: [{ requestId: 1, summary: "x" }] });
    useUiStore.getState().selectGraph("s1");

    useUiStore.getState().resetPaneChrome();

    expect(useUiStore.getState().transcript["s1"]?.[0]?.text).toBe("hi");
    expect(useUiStore.getState().permissions["s1"]).toEqual([{ requestId: 1, summary: "x" }]);
    expect(useUiStore.getState().graphSessionId).toBeNull();
  });

  it("keeps snooze beside permissions and does not drop it with pane chrome", () => {
    useUiStore.getState().setSnooze("s1", 9);
    useUiStore.getState().replacePermissions({ s1: [{ requestId: 1, summary: "x" }] });
    useUiStore.getState().resetPaneChrome();

    expect(useUiStore.getState().snoozedUntil).toEqual({ s1: 9 });
    expect(useUiStore.getState().permissions["s1"]).toEqual([{ requestId: 1, summary: "x" }]);

    useUiStore.getState().dropExpiredSnooze(10);
    expect(useUiStore.getState().snoozedUntil).toEqual({});
  });
});
