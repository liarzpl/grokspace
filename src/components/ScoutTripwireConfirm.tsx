import { useEffect, useRef } from "react";

import { overlapStrip, overlapsOf } from "../lib/overlap";
import { subscribeOverlay } from "../lib/overlay";
import { useDiffStore } from "../stores/diffStore";
import { useTaskStore } from "../stores/taskStore";
import { TextButton } from "./ui";

/** Scout is the recommended look. Spec and Dispatch anyway stay on the original target. */
export default function ScoutTripwireConfirm() {
  const pending = useTaskStore((state) => state.scoutTripwire);
  const resolve = useTaskStore((state) => state.resolveScoutTripwire);
  const cancel = useTaskStore((state) => state.cancelScoutTripwire);
  const title = useTaskStore((state) => {
    const offer = state.scoutTripwire;
    if (offer === null) return null;
    return state.tasks.find((task) => task.id === offer.taskId)?.title ?? null;
  });
  const reason = useDiffStore((state) => overlapStrip(overlapsOf(state.diff)));
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pending === null) return;
    return subscribeOverlay(true, dialogRef.current, cancel, { initialFocus: "first" });
  }, [pending, cancel]);

  if (pending === null) return null;

  return (
    <div
      onMouseDown={cancel}
      className="fixed inset-0 z-[60] flex items-start justify-center bg-canvas/70 pt-[12vh]"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scout-tripwire-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[28rem] flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60"
      >
        <header className="border-b border-line px-4 py-2.5">
          <h2 id="scout-tripwire-title" className="text-[13px] font-semibold text-ink">
            Scout or Spec first?
          </h2>
        </header>
        <p className="px-4 py-3 text-[12px] leading-snug text-ink-muted selectable">
          {reason ?? "This workspace has overlapping trees."}{" "}
          {title !== null
            ? `Hand out “${title}” to Scout, stay in Spec, or dispatch anyway.`
            : "Scout, Spec, or dispatch anyway."}
        </p>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
          <TextButton label="Scout" primary onClick={() => resolve("scout")} />
          <TextButton label="Spec" onClick={() => resolve("spec")} />
          <TextButton label="Dispatch anyway" onClick={() => resolve("anyway")} />
        </div>
      </div>
    </div>
  );
}
