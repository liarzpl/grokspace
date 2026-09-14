/**
 * Shared class recipes for the quiet chrome used across panels.
 *
 * CardButton, ChipButton, PanelButton, StepButton, PaneButton, and the
 * permission chips were the same 10px faint pill with slightly different
 * padding. One string, so a hover tweak does not have to visit six files.
 */

export const QUIET_BUTTON_CLASS =
  "rounded-sm px-1 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted disabled:opacity-30 disabled:hover:bg-transparent";

export const TEXT_BUTTON_CLASS =
  "rounded-md border border-line-strong px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-50";

export const TEXT_BUTTON_PRIMARY_CLASS =
  "rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50";

export function textButtonClass(primary?: boolean): string {
  return primary === true ? TEXT_BUTTON_PRIMARY_CLASS : TEXT_BUTTON_CLASS;
}

export const CHOICE_IDLE_CLASS =
  "text-ink-faint hover:bg-elevated hover:text-ink-muted";

export const CHOICE_ACTIVE_CLASS = "bg-accent-soft text-ink";

export function choiceOptionClass(active: boolean): string {
  return `rounded-sm px-2 py-0.5 text-[11px] transition-colors ${
    active ? CHOICE_ACTIVE_CLASS : CHOICE_IDLE_CLASS
  }`;
}
