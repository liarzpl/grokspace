import { useEffect, type ReactNode } from "react";

import { homeRelative } from "../lib/paths";
import { skillOf, useSkillStore, type SkillId, type SkillSlot } from "../stores/skillStore";

const QUIET =
  "rounded-sm px-1 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted disabled:opacity-30 disabled:hover:bg-transparent";
const TEXT =
  "rounded-md border border-line-strong px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50";

/** Loads the slot on mount so six panes do not each grow their own effect. */
export function useSkill(id: SkillId): SkillSlot {
  const slot = useSkillStore((state) => skillOf(state.byId, id));
  const load = useSkillStore((state) => state.load);

  useEffect(() => {
    void load(id);
  }, [id, load]);

  return slot;
}

export function SkillInstallButton({
  id,
  installLabel,
  updateLabel,
  variant = "quiet",
}: {
  id: SkillId;
  installLabel: string;
  updateLabel: string;
  variant?: "quiet" | "text" | "primary";
}) {
  const slot = useSkill(id);
  const install = useSkillStore((state) => state.install);
  const skill = slot.status;
  if (skill === null || skill.current) return null;

  const className = variant === "primary" ? PRIMARY : variant === "text" ? TEXT : QUIET;
  return (
    <button
      type="button"
      onClick={() => void install(id)}
      disabled={slot.isInstalling}
      className={className}
    >
      {slot.isInstalling ? "Installing…" : skill.installed ? updateLabel : installLabel}
    </button>
  );
}

/**
 * Install button plus the two sentences every panel used to copy: "it is
 * current" and "this is the directory Grok will read".
 */
export function SkillHint({
  id,
  installLabel,
  updateLabel,
  currentLabel,
  variant = "quiet",
  hint,
}: {
  id: SkillId;
  installLabel: string;
  updateLabel: string;
  currentLabel: string;
  variant?: "quiet" | "text" | "primary";
  hint?: ReactNode;
}) {
  const slot = useSkill(id);
  const skill = slot.status;

  if (skill?.current === true) {
    return <p className="text-[10px] leading-snug text-ink-faint">{currentLabel}</p>;
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <SkillInstallButton
        id={id}
        installLabel={installLabel}
        updateLabel={updateLabel}
        variant={variant}
      />
      {skill !== null && !skill.installed && (
        <p className="text-[10px] leading-snug text-ink-faint">
          Installing writes the skill into{" "}
          <span className="font-mono selectable">{homeRelative(skill.path)}</span>, which is
          where Grok looks for them.
          {hint}
        </p>
      )}
    </div>
  );
}
