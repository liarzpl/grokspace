import { beforeEach, describe, expect, it } from "vitest";

import { useUiStore } from "./uiStore";

const initial = useUiStore.getState();

beforeEach(() => {
  useUiStore.setState(initial, true);
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
