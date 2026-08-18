import { useEffect, useRef, useState } from "react";

import { useSessionStore } from "../stores/sessionStore";
import type { AgentUpdate, AgentUpdateKind, Session } from "../types";

const EMPTY: AgentUpdate[] = [];

const KIND_LABEL: Record<AgentUpdateKind, string> = {
  prompt: "you",
  message: "grok",
  thought: "thought",
  tool: "tool",
  plan: "plan",
};

const KIND_CLASS: Record<AgentUpdateKind, string> = {
  prompt: "text-accent",
  message: "text-ink",
  thought: "text-ink-faint italic",
  tool: "font-mono text-ink-muted",
  plan: "whitespace-pre-wrap font-mono text-ink-muted",
};

function TranscriptLine({ entry }: { entry: AgentUpdate }) {
  return (
    <p className={`text-[11px] leading-snug ${KIND_CLASS[entry.kind]}`}>
      <span className="mr-1.5 font-mono text-[10px] not-italic text-ink-faint">
        {KIND_LABEL[entry.kind]}
      </span>
      <span className="selectable">{entry.text}</span>
    </p>
  );
}

/**
 * The conversation an ACP agent has no pane to show. Follow-up is idle-only:
 * a second `session/prompt` while one is in flight would stack. Cancel
 * interrupts the turn; Stop, on the chip, still kills the process.
 */
export default function AgentTranscript({ session }: { session: Session }) {
  const entries = useSessionStore((state) => state.transcript[session.id] ?? EMPTY);
  const promptSession = useSessionStore((state) => state.promptSession);
  const cancelSession = useSessionStore((state) => state.cancelSession);
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries]);

  useEffect(() => {
    setDraft("");
  }, [session.id]);

  const idle = session.status === "idle";
  const running = session.status === "running";

  const send = () => {
    const text = draft.trim();
    if (!text || !idle) return;
    setDraft("");
    void promptSession(session.id, text);
  };

  return (
    <section className="flex max-h-56 shrink-0 flex-col border-t border-line bg-panel">
      <header className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <h2 className="text-[11px] font-medium text-ink-muted">Transcript</h2>
        <span className="font-mono text-[10px] text-ink-faint">{session.status}</span>
        <div className="flex-1" />
        {running && (
          <button
            type="button"
            onClick={() => void cancelSession(session.id)}
            className="rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted"
          >
            Cancel
          </button>
        )}
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
        {entries.length === 0 ? (
          <p className="text-[11px] text-ink-faint">The agent has not said anything yet.</p>
        ) : (
          <div className="flex flex-col gap-1 py-0.5">
            {entries.map((entry, index) => (
              <TranscriptLine key={`${index}-${entry.kind}`} entry={entry} />
            ))}
          </div>
        )}
      </div>

      {idle && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
          className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-1.5"
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Follow up…"
            className="min-w-0 flex-1 rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-ink outline-none placeholder:text-ink-faint selectable focus:border-accent"
          />
          <button
            type="submit"
            disabled={draft.trim() === ""}
            className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Send
          </button>
        </form>
      )}
    </section>
  );
}
