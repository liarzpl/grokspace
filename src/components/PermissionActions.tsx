import { permissionChips } from "../lib/permissions";
import type { PermissionRequest } from "../types";
import { QuietButton } from "./ui";

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
        <QuietButton
          key={chip.key}
          label={chip.label}
          disabled={chip.disabled}
          title={chip.disabled ? "The agent did not offer this option" : undefined}
          onClick={() => onAnswer(chip.allow, chip.optionId)}
        />
      ))}
    </div>
  );
}
