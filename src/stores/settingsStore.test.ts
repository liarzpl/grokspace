import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Settings } from "../types";

const readSettings = vi.fn();
const writeSetting = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { errorMessage: actual.errorMessage, api: { readSettings, writeSetting } };
});

const { useSettingsStore } = await import("./settingsStore");

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  defaultLayout: "2x2",
  openingTab: "terminals",
  defaultDispatch: "pane",
  ...overrides,
});

const initialState = useSettingsStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState(initialState, true);
});

describe("settings", () => {
  it("start at the defaults, so nothing has to guard the moment before they load", () => {
    expect(useSettingsStore.getState().settings).toEqual(settings());
  });

  it("take what the backend reports", async () => {
    readSettings.mockResolvedValue(settings({ openingTab: "tasks", defaultLayout: "3x2" }));

    const loaded = await useSettingsStore.getState().loadSettings();

    expect(loaded.openingTab).toBe("tasks");
    expect(useSettingsStore.getState().settings.defaultLayout).toBe("3x2");
  });

  it("keep working defaults when the read fails, and say so", async () => {
    // A failed read should leave a usable app, but a preference silently not applying
    // is worse than a banner.
    readSettings.mockRejectedValue("database is locked");

    const loaded = await useSettingsStore.getState().loadSettings();

    expect(loaded).toEqual(settings());
    expect(useSettingsStore.getState().settings).toEqual(settings());
    expect(useSettingsStore.getState().error).toBe("database is locked");
  });

  it("take the whole set back from a write, since the backend fills the defaults", async () => {
    writeSetting.mockResolvedValue(settings({ openingTab: "memory" }));

    await useSettingsStore.getState().setSetting("openingTab", "memory");

    expect(writeSetting).toHaveBeenCalledWith("openingTab", "memory");
    expect(useSettingsStore.getState().settings.openingTab).toBe("memory");
  });

  it("report a refused write and change nothing", async () => {
    writeSetting.mockRejectedValue("`9x9` is not one of the values `defaultLayout` can take");

    await useSettingsStore.getState().setSetting("defaultLayout", "9x9");

    expect(useSettingsStore.getState().settings.defaultLayout).toBe("2x2");
    expect(useSettingsStore.getState().error).toContain("9x9");
  });
});
