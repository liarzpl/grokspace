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
