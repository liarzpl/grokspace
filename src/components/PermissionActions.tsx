import { permissionChips } from "../lib/permissions";
import type { PermissionRequest } from "../types";

/**
 * Allow, Deny, and any always-allow / always-deny the agent offered by name.
 *
 * Primary Allow never sends `allow_always`; that chip is separate on purpose.
 */
export function PermissionActions({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer: (allow: boolean, optionId?: string) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5">
      {permissionChips(request).map((chip) => (
        <button
          key={chip.key}
          type="button"
          disabled={chip.disabled}
          title={chip.disabled ? "The agent did not offer this option" : undefined}
          onClick={() => onAnswer(chip.allow, chip.optionId)}
          className="rounded-sm px-1 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted disabled:opacity-30 disabled:hover:bg-transparent"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
