import { useEffect } from "react";

import { subscribeEscape } from "../lib/shortcuts";
import { TABS, useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { PANE_LAYOUTS, type Settings } from "../types";

/**
 * An overlay rather than a tab.
 *
 * Tabs are the panels you move between while working, and settings is not one of
 * them — a sixth tab would have turned that row into a menu. It is reached from the
 * command palette, which is what a palette is for.
 *
 * There is no theme switch here, though the roadmap named one and `styles.css` has
 * promised it since Phase 0. A control with one option is a control that does
 * nothing, and this app has already had to fix two of those. The colour tokens moved
 * out of the components in this PR, which is the part of theming that was actually
 * blocking; a switch belongs in the PR that adds the second palette.
 */

function Choice<T extends string>({
  label,
  hint,
  options,
  value,
  onChoose,
}: {
  label: string;
  hint: string;
  options: readonly T[];
  value: T;
  onChoose: (option: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12px] font-medium text-ink">{label}</h3>
        <span className="text-[10px] text-ink-faint">{hint}</span>
      </div>
      <div className="flex flex-wrap items-center gap-0.5 self-start rounded-md border border-line p-0.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChoose(option)}
            className={`rounded-sm px-2 py-0.5 text-[11px] transition-colors ${
              option === value
                ? "bg-accent-soft text-ink"
                : "text-ink-faint hover:bg-elevated hover:text-ink-muted"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPanel() {
  const isOpen = useUiStore((state) => state.isSettingsOpen);
  const closeSettings = useUiStore((state) => state.closeSettings);
  const settings = useSettingsStore((state) => state.settings);
  const setSetting = useSettingsStore((state) => state.setSetting);

  useEffect(() => subscribeEscape(isOpen, closeSettings), [isOpen, closeSettings]);

  if (!isOpen) return null;

  return (
    <div
      onMouseDown={closeSettings}
      className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/70 pt-[12vh]"
    >
      <div
        role="dialog"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[70vh] w-[30rem] flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60"
      >
        <header className="flex shrink-0 items-baseline gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">Settings</h2>
          <span className="text-[10px] text-ink-faint">Shared by every project</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={closeSettings}
            className="rounded-sm px-2 py-0.5 text-[11px] text-ink-faint transition-colors hover:text-ink"
          >
            Done
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <Choice
            label="Default layout"
            hint="What a project that has never chosen one gets"
            options={PANE_LAYOUTS}
            value={settings.defaultLayout}
            onChoose={(layout) => void setSetting("defaultLayout", layout)}
          />

          <Choice
            label="Open on"
            hint="Somebody who works from the board should not click past the terminals"
            options={TABS.map((tab) => tab.id)}
            value={settings.openingTab}
            onChoose={(tab) => void setSetting("openingTab", tab)}
          />

          <Choice
            label="Dispatch reaches for"
            hint="Which new session is offered first when a task is handed out"
            options={["pane", "agent"] as const}
            value={settings.defaultDispatch}
            onChoose={(target) => void setSetting("defaultDispatch", target)}
          />

          <p className="text-[10px] leading-relaxed text-ink-faint">
            Changing the default layout does not move a project that has already picked
            one. Changing what the workspace opens on takes effect next launch, not now —
            yanking you to another panel mid-thought would be the wrong kind of helpful.
            Dispatch only reorders what is offered; it never picks a target for you.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Exported for the tests: the keys a panel control is allowed to write. */
export type SettingKey = keyof Settings;
