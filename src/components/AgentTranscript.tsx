import { useEffect, useId, useRef, useState } from "react";

import { MAX_MEMORY_CHARS } from "../lib/limits";
import {
  DEFAULT_MEMORY_PROPOSE_TYPE,
  draftFromTranscriptText,
  MEMORY_PROPOSE_TYPES,
  memoryWouldExceedCap,
  offersMemoryChip,
  type MemoryProposeType,
} from "../lib/memoryPropose";
import { moveSegmented } from "../lib/segmented";
import {
  growTranscriptWindow,
  transcriptRowKey,
  TRANSCRIPT_WINDOW,
  windowTranscript,
} from "../lib/transcript";
import { useEntriesForProject, useMemoryStore } from "../stores/memoryStore";
import { useSessionStore } from "../stores/sessionStore";
import type { AgentUpdate, AgentUpdateKind, Session } from "../types";
import { QuietButton } from "./ui";

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

const FIELD =
  "selectable rounded-sm border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

/**
 * Files through `createEntry`. The Markdown projection is the backend's job.
 */
function MemoryProposeChip({ projectId, text }: { projectId: string; text: string }) {
  const createEntry = useMemoryStore((state) => state.createEntry);
  const entries = useEntriesForProject(projectId);
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [type, setType] = useState<MemoryProposeType>(DEFAULT_MEMORY_PROPOSE_TYPE);

  const openForm = () => {
    const draft = draftFromTranscriptText(text);
    setKey(draft.key);
    setContent(draft.content);
    setType(DEFAULT_MEMORY_PROPOSE_TYPE);
    setOpen(true);
  };

  const overCap = memoryWouldExceedCap(entries, key, content);
  const canSave = key.trim() !== "" && content.trim() !== "" && !overCap;

  const save = async () => {
    if (!canSave) return;
    if (await createEntry(projectId, { key: key.trim(), content: content.trim(), type })) {
      setOpen(false);
    }
  };

  if (!open) return <QuietButton label="Add to Memory" onClick={openForm} />;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="mb-0.5 flex flex-col gap-1 rounded-md border border-line bg-canvas px-1.5 py-1"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={key}
          onChange={(event) => setKey(event.target.value)}
          aria-label="Memory key"
          placeholder="key, for example database"
          className={`${FIELD} w-36 font-mono`}
        />
        <div
          role="radiogroup"
          aria-label="Memory type"
          onKeyDown={(event) =>
            moveSegmented(event, MEMORY_PROPOSE_TYPES, type, setType, (next) => `${formId}-${next}`)
          }
          className="flex items-center gap-0.5 rounded-md border border-line p-0.5"
        >
          {MEMORY_PROPOSE_TYPES.map((candidate) => (
            <button
              key={candidate}
              id={`${formId}-${candidate}`}
              type="button"
              role="radio"
              aria-checked={candidate === type}
              tabIndex={candidate === type ? 0 : -1}
              onClick={() => setType(candidate)}
              className={`rounded-sm px-1.5 py-0.5 text-[10px] capitalize transition-colors ${
                candidate === type
                  ? "bg-accent-soft text-ink"
                  : "text-ink-faint hover:bg-elevated hover:text-ink-muted"
              }`}
            >
              {candidate}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        aria-label="Memory content"
        rows={2}
        className={`${FIELD} w-full resize-y`}
      />
      <div className="flex items-center gap-1">
        <button
          type="submit"
          disabled={!canSave}
          title={
            overCap ? `This project's memory would pass ${MAX_MEMORY_CHARS} characters` : undefined
          }
          className="rounded-md bg-accent px-2 py-0.5 text-[10px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Remember
        </button>
        <QuietButton label="Cancel" onClick={() => setOpen(false)} />
      </div>
      {overCap && (
        <p className="text-[10px] text-warning">
          This note would pass the {MAX_MEMORY_CHARS}-character cap every session reads.
        </p>
      )}
    </form>
  );
}

function EarlierRows({
  hidden,
  visible,
  total,
  onMore,
}: {
  hidden: number;
  visible: number;
  total: number;
  onMore: () => void;
}) {
  if (hidden <= 0) return null;
  const next = growTranscriptWindow(visible, total) - visible;
  return (
    <button
      type="button"
      onClick={onMore}
      className="mb-1 block w-full rounded-sm px-1.5 py-1 text-left text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted"
    >
      Show {next} earlier {next === 1 ? "line" : "lines"} ({hidden} hidden)
    </button>
  );
}

function TranscriptLine({
  entry,
  offerMemory,
  projectId,
}: {
  entry: AgentUpdate;
  offerMemory: boolean;
  projectId: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className={`text-[11px] leading-snug ${KIND_CLASS[entry.kind]}`}>
        <span className="mr-1.5 font-mono text-[10px] not-italic text-ink-faint">
          {KIND_LABEL[entry.kind]}
        </span>
        <span className="selectable">{entry.text}</span>
      </p>
      {offerMemory && <MemoryProposeChip projectId={projectId} text={entry.text} />}
    </div>
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
  const [limit, setLimit] = useState(TRANSCRIPT_WINDOW);
  const scroller = useRef<HTMLDivElement>(null);
  const windowed = windowTranscript(entries, limit);
  const followingTail = limit <= TRANSCRIPT_WINDOW;

  useEffect(() => {
    if (!followingTail) return;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries, followingTail]);

  useEffect(() => {
    setDraft("");
    setLimit(TRANSCRIPT_WINDOW);
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
            <EarlierRows
              hidden={windowed.hidden}
              visible={windowed.shown.length}
              total={entries.length}
              onMore={() => setLimit((current) => growTranscriptWindow(current, entries.length))}
            />
            {windowed.shown.map((entry, index) => {
              const absolute = windowed.offset + index;
              return (
                <TranscriptLine
                  key={transcriptRowKey(absolute, entry.kind)}
                  entry={entry}
                  projectId={session.projectId}
                  offerMemory={offersMemoryChip(entry, absolute === entries.length - 1)}
                />
              );
            })}
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
            aria-label={`Follow up to ${session.title ?? "agent"}`}
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
