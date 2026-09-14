import { useEffect, useRef } from "react";

import { subscribeOverlay } from "../lib/overlay";
import { useSessionStore } from "../stores/sessionStore";
import { TextButton } from "./ui";

/** Cancel leaves the agent unstarted. After Start, the isolation banner still shows. */
export default function IsolationConfirm() {
  const pending = useSessionStore((state) => state.isolationConfirm);
  const confirm = useSessionStore((state) => state.confirmUnisolatedStart);
  const cancel = useSessionStore((state) => state.cancelUnisolatedStart);
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
        aria-labelledby="isolation-confirm-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[28rem] flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60"
      >
        <header className="border-b border-line px-4 py-2.5">
          <h2 id="isolation-confirm-title" className="text-[13px] font-semibold text-ink">
            Start on the project tree?
          </h2>
        </header>
        <p className="px-4 py-3 text-[12px] leading-snug text-ink-muted selectable">{pending.message}</p>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
          <TextButton label="Cancel" onClick={cancel} />
          <TextButton label="Start on the project tree" primary onClick={confirm} />
        </div>
      </div>
    </div>
  );
}
