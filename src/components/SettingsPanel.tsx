import { useEffect, useRef, useState } from "react";

import { api, errorMessage } from "../lib/api";
import { subscribeOverlay } from "../lib/overlay";
import { homeRelative } from "../lib/paths";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  DISPATCH_TARGETS,
  PANE_LAYOUTS,
  PERMISSION_POLICY_ACTIONS,
  WORKSPACE_TABS,
  WORKTREE_SETUP,
  type PermissionPolicy,
  type PermissionPolicyAction,
  type PermissionPolicyRule,
  type Settings,
  type WorktreeGcEntry,
} from "../types";
import { Choice, QuietButton } from "./ui";

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

          <PermissionPolicyEditor />

          <WorktreeGcEditor />

          <p className="text-[10px] leading-relaxed text-ink-faint">
            Changing the default layout does not move a project that has already picked
            one. Changing what the workspace opens on takes effect next launch, not now —
            yanking you to another panel mid-thought would be the wrong kind of helpful.
            Dispatch only reorders what is offered; it never picks a target for you.
            Worktree setup stays off until you turn it on — a clone must not run that
            script for you. Permission globs: Deny wins; allow-once-similar is never Always.
            Orphan worktrees are a dry-run; dirty trees stay.
          </p>
        </div>
      </div>
    </div>
  );
}

function PermissionPolicyEditor() {
  const [policy, setPolicy] = useState<PermissionPolicy | null>(null);
  const [action, setAction] = useState<PermissionPolicyAction>("deny");
  const [pattern, setPattern] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .readPermissionPolicy()
      .then((next) => {
        setPolicy(next);
        setError(null);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  const save = (rules: PermissionPolicyRule[]) => {
    void api
      .writePermissionPolicy(rules)
      .then((next) => {
        setPolicy(next);
        setError(null);
        setPattern("");
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  };

  const add = () => {
    const next = pattern.trim();
    if (next === "" || policy === null) return;
    save([...policy.rules, { action, pattern: next }]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12px] font-medium text-ink">Permission policy</h3>
        <span className="text-[10px] text-ink-faint">
          {policy ? `${homeRelative(policy.path)}; also ${policy.projectFile}` : "User globs"}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {(policy?.rules ?? []).map((rule, index) => (
          <li key={`${rule.action}:${rule.pattern}:${index}`} className="flex min-w-0 items-center gap-1 text-[11px]">
            <span className="shrink-0 text-ink-faint">{rule.action}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-[10px]">{rule.pattern}</code>
            <QuietButton
              label="Remove"
              title="Remove this rule"
              onClick={() => save((policy?.rules ?? []).filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1">
        <select
          aria-label="Policy action"
          value={action}
          onChange={(event) => setAction(event.target.value as PermissionPolicyAction)}
          className="rounded-sm border border-line bg-canvas px-1 py-0.5 text-[11px] text-ink"
        >
          {PERMISSION_POLICY_ACTIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          aria-label="Policy glob"
          value={pattern}
          placeholder="*git push*"
          onChange={(event) => setPattern(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          className="selectable min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1 py-0.5 text-[11px] text-ink focus:outline-none"
        />
        <QuietButton label="Add" title="Add a user glob. Deny wins." onClick={add} />
      </div>
      {error !== null && (
        <p role="alert" className="text-[10px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function WorktreeGcEditor() {
  const projectId = useProjectStore((state) => state.activeProjectId);
  const [entries, setEntries] = useState<WorktreeGcEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (action: "scan" | "remove") => {
    if (projectId === null) return;
    setBusy(true);
    const request =
      action === "scan" ? api.previewWorktreeGc(projectId) : api.gcOrphanWorktrees(projectId);
    void request
      .then((next) => {
        setEntries(next);
        setError(null);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  const removable = entries?.filter((entry) => entry.removable).length ?? 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12px] font-medium text-ink">Orphan worktrees</h3>
        <span className="text-[10px] text-ink-faint">No session row. Dirty stays.</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {(entries ?? []).map((entry) => (
          <li
            key={entry.path}
            className="flex min-w-0 items-center gap-1 text-[11px]"
            title={entry.skipReason ?? entry.path}
          >
            <code className="min-w-0 flex-1 truncate font-mono text-[10px]">{entry.sessionId}</code>
            <span className="shrink-0 text-ink-faint">{formatBytes(entry.sizeBytes)}</span>
            <span className="shrink-0 text-ink-faint">
              {entry.dirty ? "dirty" : entry.removable ? "clean" : "skip"}
            </span>
          </li>
        ))}
      </ul>
      {entries !== null && entries.length === 0 && (
        <p className="text-[10px] text-ink-faint">No leftover worktrees</p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <QuietButton
          label="Scan leftovers"
          title={projectId === null ? "Open a project first" : "Dry-run sizes. Nothing is deleted."}
          disabled={busy || projectId === null}
          onClick={() => run("scan")}
        />
        <QuietButton
          label={removable === 1 ? "Remove 1 clean" : `Remove ${removable} clean`}
          title="Remove only clean orphans. Dirty trees are never force-deleted."
          disabled={busy || removable === 0}
          onClick={() => run("remove")}
        />
      </div>
      {error !== null && (
        <p role="alert" className="text-[10px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Exported for the tests: the keys a panel control is allowed to write. */
export type SettingKey = keyof Settings;
export { SettingsPanel };
