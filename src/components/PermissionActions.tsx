import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  grantSessionLease,
  leaseCanAutoAnswer,
  leaseLabel,
  matchSessionLease,
  proposedLease,
  syncSessionLeases,
} from "../lib/permissionLease";
import { permissionChips } from "../lib/permissions";
import { loadedOverlapPaths, permissionWhyFrom } from "../lib/permissionWhy";
import { useDiffStore } from "../stores/diffStore";
import { useSessionStore } from "../stores/sessionStore";
import { stepsFor, useStepStore } from "../stores/stepStore";
import type { PermissionRequest } from "../types";
import { QuietButton } from "./ui";

/**
 * Allow, Deny, and any always-allow / always-deny the agent offered by name.
 *
 * Primary Allow never sends `allow_always`; that chip is separate on purpose.
 * After Allow, "Also this session: Edit src/**" opts into matching prompts
 * answered as `allow_once` until Stop or Restart. Under the chips: known
 * session title, `doing` step, worktree, overlap paths.
 */
export function PermissionActions({
  request,
  sessionId,
  onAnswer,
}: {
  request: PermissionRequest;
  sessionId?: string;
  onAnswer: (allow: boolean, optionId?: string) => void;
}) {
  const session = useSessionStore((state) =>
    sessionId === undefined
      ? undefined
      : state.sessions.find((row) => row.id === sessionId),
  );
  const sessions = useSessionStore((state) => state.sessions);
  const steps = useStepStore((state) => stepsFor(state.bySession, sessionId).steps);
  const { scope, diff, isLoading } = useDiffStore(
    useShallow((state) => ({
      scope: state.scope,
      diff: state.diff,
      isLoading: state.isLoading,
    })),
  );
  const why =
    sessionId === undefined
      ? null
      : permissionWhyFrom(
          session,
          steps,
          loadedOverlapPaths(diff, scope, sessionId, !isLoading),
        );

  const canOnce = leaseCanAutoAnswer(request);
  const matched =
    sessionId !== undefined && canOnce
      ? matchSessionLease(sessionId, request.summary, sessions)
      : undefined;
  const offer =
    sessionId !== undefined && matched === undefined && canOnce
      ? proposedLease(request.summary)
      : null;

  useEffect(() => {
    syncSessionLeases(sessions);
  }, [sessions]);

  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const autoKey = useRef<string | null>(null);
  useEffect(() => {
    if (sessionId === undefined || matched === undefined || !canOnce) return;
    const key = `${sessionId}:${request.requestId}`;
    if (autoKey.current === key) return;
    autoKey.current = key;
    onAnswerRef.current(true);
  }, [sessionId, request.requestId, matched, canOnce]);

  if (matched !== undefined) {
    return (
      <div className="flex min-w-0 shrink-0 flex-col gap-0.5">
        <p
          data-testid="permission-lease-auto"
          className="min-w-0 text-[10px] leading-snug text-ink-faint"
        >
          Allowing {leaseLabel(matched)} this session
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-0.5">
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
        {offer !== null && sessionId !== undefined && (
          <QuietButton
            label={`Also this session: ${leaseLabel(offer)}`}
            title="Allow matching prompts this session as Allow once. Stop or Restart ends the lease."
            onClick={() => {
              grantSessionLease(sessionId, offer);
              onAnswer(true);
            }}
          />
        )}
      </div>
      {why !== null && (
        <p data-testid="permission-why" className="min-w-0 text-[10px] leading-snug text-ink-faint">
          {why}
        </p>
      )}
    </div>
  );
}
