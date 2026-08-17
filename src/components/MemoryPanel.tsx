import { useEffect, useState } from "react";

import { homeRelative } from "../lib/paths";
import { entriesOfType, MEMORY_TYPES, memorySize, useMemoryStore } from "../stores/memoryStore";
import type { MemoryEntry, MemoryEntryType, Project } from "../types";

/**
 * A copy of the cap `memory.rs` enforces, used only to warn before it bites.
 *
 * Deliberately not fetched from the backend: it would be a command and a round trip
 * to render one sentence. The two drifting apart makes the warning early or late,
 * never wrong about whether a write is refused — the backend is what refuses, and it
 * says so.
 */
const MAX_MEMORY_CHARS = 32 * 1024;

function PanelButton({
  label,
  onClick,
  primary,
  disabled,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        primary === true
          ? "rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
          : "rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted disabled:opacity-40"
      }
    >
      {label}
    </button>
  );
}

/**
 * One entry, editable in place.
 *
 * The key is not editable: it is the primary key, so changing it would be a new
 * entry plus a deletion rather than an edit, and doing that silently behind a text
 * field would lose the original on a typo.
 */
function EntryRow({ entry, projectId }: { entry: MemoryEntry; projectId: string }) {
  const putEntry = useMemoryStore((state) => state.putEntry);
  const forgetEntry = useMemoryStore((state) => state.forgetEntry);
  const [draft, setDraft] = useState<string | null>(null);

  const save = async () => {
    if (draft === null) return;
    const next = draft;
    // Closed only once the write lands, so a refused write - the cap, or an empty
    // body - leaves the text still there to fix.
    const ok = await putEntry(projectId, { key: entry.key, content: next, type: entry.type });
    if (ok) setDraft(null);
  };

  return (
    <div className="rounded-md border border-line bg-panel p-2">
      <div className="flex items-baseline gap-2">
        <h3 className="font-mono text-[11px] text-ink">{entry.key}</h3>
        <div className="flex-1" />
        {draft === null ? (
          <>
            <PanelButton label="Edit" onClick={() => setDraft(entry.content)} />
            <PanelButton label="Forget" onClick={() => void forgetEntry(projectId, entry.key)} />
          </>
        ) : (
          <>
            <PanelButton label="Save" onClick={() => void save()} />
            <PanelButton label="Cancel" onClick={() => setDraft(null)} />
          </>
        )}
      </div>

      {draft === null ? (
        <p className="selectable mt-1 whitespace-pre-wrap text-[11px] leading-snug text-ink-muted">
          {entry.content}
        </p>
      ) : (
        <textarea
          autoFocus
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="selectable mt-1 w-full resize-y rounded-sm border border-accent bg-canvas px-1.5 py-1 text-[11px] leading-snug text-ink focus:outline-none"
        />
      )}
    </div>
  );
}

function NewEntryForm({ projectId }: { projectId: string }) {
  const putEntry = useMemoryStore((state) => state.putEntry);
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [type, setType] = useState<MemoryEntryType>("context");

  // Both halves are needed, and the button says so by being disabled rather than by
  // accepting the click and doing nothing. A control that looks pressable and is not
  // is the same trap the task board's hidden controls were.
  const ready = key.trim() !== "" && content.trim() !== "";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    if (await putEntry(projectId, { key, content, type })) {
      setKey("");
      setContent("");
    }
  };

  const field =
    "selectable rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex shrink-0 flex-col gap-1.5 border-b border-line px-3 py-2"
    >
      <div className="flex items-center gap-1.5">
        <input
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="key, for example database"
          className={`${field} w-56 font-mono`}
        />
        <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
          {MEMORY_TYPES.map(({ type: candidate, label }) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setType(candidate)}
              className={`rounded-sm px-2 py-0.5 text-[11px] transition-colors ${
                candidate === type
                  ? "bg-accent-soft text-ink"
                  : "text-ink-faint hover:bg-elevated hover:text-ink-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-1.5">
        <input
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="What should everyone working here already know?"
          className={`${field} min-w-0 flex-1`}
        />
        {/* A submit button rather than relying on Enter: with two fields the form has
            no implicit submission, so this is the thing that makes the keyboard work. */}
        <button
          type="submit"
          disabled={!ready}
          title={ready ? undefined : "A memory entry needs both a key and something to remember"}
          className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40"
        >
          Remember
        </button>
      </div>
    </form>
  );
}

/**
 * Where the memory goes and what teaches agents to read it.
 *
 * The path is named rather than assumed present: writing it is best-effort, since a
 * project folder that will not take the file is not a reason to refuse a note, so
 * this is how its absence stays discoverable.
 */
function MemoryFooter() {
  const filePath = useMemoryStore((state) => state.filePath);
  const skill = useMemoryStore((state) => state.skill);
  const isInstalling = useMemoryStore((state) => state.isInstallingSkill);
  const loadSkill = useMemoryStore((state) => state.loadSkill);
  const installSkill = useMemoryStore((state) => state.installSkill);

  useEffect(() => {
    void loadSkill();
  }, [loadSkill]);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3 py-2">
      {filePath !== "" && (
        <p className="min-w-0 text-[10px] text-ink-faint">
          Sessions read{" "}
          <span className="font-mono selectable break-all text-ink-muted">
            {homeRelative(filePath)}
          </span>
        </p>
      )}
      <div className="flex-1" />
      {skill !== null && !skill.current && (
        <PanelButton
          primary
          label={
            isInstalling
              ? "Installing…"
              : skill.installed
                ? "Update the memory skill"
                : "Install the memory skill"
          }
          onClick={() => void installSkill()}
          disabled={isInstalling}
        />
      )}
      {skill?.current === true && (
        <p className="text-[10px] text-ink-faint">
          The memory skill is installed, so agents started from now on read this before
          they plan.
        </p>
      )}
    </div>
  );
}

export default function MemoryPanel({ project }: { project: Project }) {
  const entries = useMemoryStore((state) => state.entries);
  const size = memorySize(entries);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NewEntryForm projectId={project.id} />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {entries.length === 0 && (
          <p className="text-[11px] leading-relaxed text-ink-muted">
            Nothing remembered yet. What goes here is what you would otherwise tell every
            agent again: the stack, the decisions already made, where things live.
          </p>
        )}

        {MEMORY_TYPES.map(({ type, label, hint }) => {
          const ofType = entriesOfType(entries, type);
          if (ofType.length === 0) return null;
          return (
            <section key={type} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <h2 className="text-[11px] font-medium text-ink-muted">{label}</h2>
                <span className="text-[10px] text-ink-faint">{hint}</span>
              </div>
              {ofType.map((entry) => (
                <EntryRow key={entry.key} entry={entry} projectId={project.id} />
              ))}
            </section>
          );
        })}

        {/* Only once it is close enough to matter: every session reads all of this, and
            the backend refuses a write that would pass the cap. */}
        {size > MAX_MEMORY_CHARS / 2 && (
          <p className="text-[10px] text-warning">
            {size} of {MAX_MEMORY_CHARS} characters used. Every session reads all of it.
          </p>
        )}
      </div>

      <MemoryFooter />
    </div>
  );
}
