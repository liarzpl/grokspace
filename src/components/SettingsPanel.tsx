import { useEffect, useRef } from "react";

import { subscribeOverlay } from "../lib/overlay";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { DISPATCH_TARGETS, PANE_LAYOUTS, WORKSPACE_TABS, WORKTREE_SETUP, type Settings } from "../types";
import { Choice } from "./ui";

/**
 * An overlay rather than a tab.
 *
 * Tabs are the panels you move between while working, and settings is not one of
 * them — a sixth tab would have turned that row into a menu. It is reached from the
 * command palette, which is what a palette is for.
 *
 * There is no theme switch here. `styles.css` still has only one palette, and a
 * control with one option is a control that does nothing. Colour tokens live in
 * that stylesheet (`theme.ts` reads them back for xterm and React Flow); a switch
 * belongs in the change that adds the second palette.
 */

export default function SettingsPanel() {
  const isOpen = useUiStore((state) => state.isSettingsOpen);
  const closeSettings = useUiStore((state) => state.closeSettings);
  const settings = useSettingsStore((state) => state.settings);
  const setSetting = useSettingsStore((state) => state.setSetting);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    return subscribeOverlay(true, dialogRef.current, closeSettings, {
      initialFocus: "container",
    });
  }, [isOpen, closeSettings]);

  if (!isOpen) return null;

  return (
    <div
      onMouseDown={closeSettings}
      className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/70 pt-[12vh]"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[70vh] w-[30rem] flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60"
      >
        <header className="flex shrink-0 items-baseline gap-2 border-b border-line px-4 py-2.5">
          <h2 id="settings-title" className="text-[13px] font-semibold text-ink">
            Settings
          </h2>
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
            options={WORKSPACE_TABS}
            value={settings.openingTab}
            onChoose={(tab) => void setSetting("openingTab", tab)}
          />

          <Choice
            label="Dispatch reaches for"
            hint="Which new session is offered first when a task is handed out"
            options={DISPATCH_TARGETS}
            value={settings.defaultDispatch}
            onChoose={(target) => void setSetting("defaultDispatch", target)}
          />

          <Choice
            label="Worktree setup"
            hint="Run .grokspace/worktree-setup after isolating an agent. Off unless you trust that file"
            options={WORKTREE_SETUP}
            value={settings.runWorktreeSetup}
            onChoose={(value) => void setSetting("runWorktreeSetup", value)}
          />

          <p className="text-[10px] leading-relaxed text-ink-faint">
            Changing the default layout does not move a project that has already picked
            one. Changing what the workspace opens on takes effect next launch, not now —
            yanking you to another panel mid-thought would be the wrong kind of helpful.
            Dispatch only reorders what is offered; it never picks a target for you.
            Worktree setup stays off until you turn it on — a clone must not run that
            script for you.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Exported for the tests: the keys a panel control is allowed to write. */
export type SettingKey = keyof Settings;
export { SettingsPanel };
