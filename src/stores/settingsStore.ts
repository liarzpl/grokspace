import { create } from "zustand";

import { api, errorMessage } from "../lib/api";
import { DEFAULT_LAYOUT, type Settings } from "../types";

/**
 * The app's preferences, as opposed to a project's.
 *
 * Held with defaults from the start rather than as `Settings | null`, so nothing has
 * to guard against a moment before the load finishes. The backend fills any missing
 * key with the same defaults, so the two agree even before they have spoken.
 */

const DEFAULTS: Settings = { defaultLayout: DEFAULT_LAYOUT, openingTab: "terminals" };

interface SettingsState {
  settings: Settings;
  error: string | null;

  loadSettings: () => Promise<Settings>;
  /** Writes one preference. The backend returns them all, so this takes its word. */
  setSetting: (key: keyof Settings, value: string) => Promise<void>;
  clearError: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULTS,
  error: null,

  clearError: () => set({ error: null }),

  loadSettings: async () => {
    try {
      const settings = await api.readSettings();
      set({ settings });
      return settings;
    } catch (error) {
      // The defaults stay, so a failed read leaves a working app rather than a blank
      // one. Reported anyway, because a preference silently not applying is worse
      // than a banner.
      set({ error: errorMessage(error) });
      return DEFAULTS;
    }
  },

  setSetting: async (key, value) => {
    try {
      set({ settings: await api.writeSetting(key, value) });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },
}));
