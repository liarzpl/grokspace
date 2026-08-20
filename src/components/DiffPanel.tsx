import { useEffect } from "react";

import { sessionsForProject, useSessionStore } from "../stores/sessionStore";
import { useDiffStore } from "../stores/diffStore";
import type { ChangedFile, FileChange, Project, Session } from "../types";

/**
 * What the agents changed, read out of git.
 *
 * Read-only except Discard, which throws away a stopped agent's worktree so Close
 * can proceed. Merge into the project branch is the next half of this phase.
 *
 * The default view is the project's tree. ACP agents that isolated into a worktree
 * appear as chips; picking one reads that checkout, which is a clean `HEAD` plus
 * whatever that agent wrote.
 */

const CHANGE_TONE: Record<FileChange, string> = {
  added: "text-success",
  untracked: "text-success",
  modified: "text-warning",
  deleted: "text-danger",
  renamed: "text-accent",
};

/** Short enough to sit in a narrow column without truncating the path beside it. */
const CHANGE_LABEL: Record<FileChange, string> = {
  added: "add",
  untracked: "new",
  modified: "mod",
  deleted: "del",
  renamed: "ren",
};

function Centred({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center text-[12px] leading-relaxed text-ink-muted">
        {children}
      </div>
    </div>
  );
}

/**
 * One line of a diff, coloured by what it is.
 *
 * Rendered line by line rather than handed to a highlighter: a diff's meaning is
 * carried almost entirely by the first character of each line, and a dependency that
 * knows every language would be a lot of bytes to colour three cases.
 */
function DiffBody({ body }: { body: string }) {
  return (
    <pre className="selectable min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed">
      {body.split("\n").map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith("+++") || line.startsWith("---")
              ? "text-ink-faint"
              : line.startsWith("@@")
                ? "text-accent"
                : line.startsWith("+")
                  ? "text-success"
                  : line.startsWith("-")
                    ? "text-danger"
                    : "text-ink-muted"
          }
        >
          {line === "" ? "\u00a0" : line}
        </div>
      ))}
    </pre>
  );
}

function FileRow({
  file,
  active,
  onSelect,
}: {
  file: ChangedFile;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={file.path}
      className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left transition-colors ${
        active ? "bg-accent-soft" : "hover:bg-elevated"
      }`}
    >
      <span className={`shrink-0 font-mono text-[10px] ${CHANGE_TONE[file.change]}`}>
        {CHANGE_LABEL[file.change]}
      </span>
      {/* Reversed so the end of a long path stays visible: the file name is what
          identifies it, and the directories above it usually repeat. */}
      <span className="min-w-0 flex-1 truncate text-left text-[11px] text-ink-muted [direction:rtl]">
        {file.path}
      </span>
    </button>
  );
}

function sessionLabel(session: Session): string {
  return session.title ?? "Agent";
}

function ScopeChips({
  projectId,
  sessions,
  scope,
  onSelect,
}: {
  projectId: string;
  sessions: Session[];
  scope: string | null;
  onSelect: (sessionId: string | null) => void;
}) {
  if (sessions.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 py-1.5">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
          scope === null
            ? "border-accent bg-accent-soft text-ink"
            : "border-line text-ink-faint hover:border-line-strong hover:text-ink-muted"
        }`}
      >
        Project
      </button>
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => onSelect(session.id)}
          className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
            scope === session.id
              ? "border-accent bg-accent-soft text-ink"
              : "border-line text-ink-faint hover:border-line-strong hover:text-ink-muted"
          }`}
        >
          {sessionLabel(session)}
        </button>
      ))}
      <div className="flex-1" />
      {scope !== null &&
        sessions.find((session) => session.id === scope)?.status === "stopped" && (
          <button
            type="button"
            onClick={() => {
              void (async () => {
                await useSessionStore.getState().discardWorktree(scope);
                const leftover = useSessionStore
                  .getState()
                  .sessions.find((session) => session.id === scope);
                if (leftover?.worktreePath === null) {
                  await useDiffStore.getState().loadDiff(projectId, null);
                }
              })();
            }}
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted"
          >
            Discard
          </button>
        )}
    </div>
  );
}

export default function DiffPanel({ project }: { project: Project }) {
  const diff = useDiffStore((state) => state.diff);
  const selected = useDiffStore((state) => state.selected);
  const body = useDiffStore((state) => state.body);
  const scope = useDiffStore((state) => state.scope);
  const isLoading = useDiffStore((state) => state.isLoading);
  const isLoadingBody = useDiffStore((state) => state.isLoadingBody);
  const loadDiff = useDiffStore((state) => state.loadDiff);
  const selectFile = useDiffStore((state) => state.selectFile);
  const sessions = useSessionStore((state) =>
    sessionsForProject(state.sessions, project.id).filter(
      (session) => session.worktreePath !== null,
    ),
  );

  useEffect(() => {
    void loadDiff(project.id, null);
  }, [project.id, loadDiff]);

  const scoped = sessions.some((session) => session.id === scope) ? scope : null;

  if (diff.state === "gitMissing") {
    return (
      <Centred>
        <p>
          This panel reads <span className="font-mono text-ink">git</span>, and there is no
          git on the PATH or in the usual install locations. Everything else in GrokSpace
          works without it.
        </p>
      </Centred>
    );
  }

  if (diff.state === "notARepo") {
    return (
      <Centred>
        <p>
          <span className="font-mono text-ink">{project.name}</span> is not inside a git
          repository, so there is nothing to compare against. Run{" "}
          <span className="font-mono text-ink">git init</span> in it and the agents&apos;
          changes will show up here.
        </p>
      </Centred>
    );
  }

  const header = (
    <header className="flex shrink-0 items-baseline gap-2 border-b border-line px-3 py-1.5">
      <span className="text-[11px] text-ink-muted">
        {diff.state === "changed"
          ? `${diff.files.length} changed ${diff.files.length === 1 ? "file" : "files"}`
          : "Nothing changed"}
      </span>
      {diff.branch !== null && (
        <span className="font-mono text-[10px] text-ink-faint">on {diff.branch}</span>
      )}
      <div className="flex-1" />
      {/* A snapshot rather than a watch: a watcher over a whole project would fire on
          every artifact an agent's test run writes. */}
      <button
        type="button"
        onClick={() => void loadDiff(project.id, scoped)}
        disabled={isLoading}
        className="rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted disabled:opacity-40"
      >
        {isLoading ? "Reading…" : "Refresh"}
      </button>
    </header>
  );

  const chips = (
    <ScopeChips
      projectId={project.id}
      sessions={sessions}
      scope={scoped}
      onSelect={(sessionId) => void loadDiff(project.id, sessionId)}
    />
  );

  if (diff.state === "clean") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {chips}
        {header}
        <Centred>
          {scoped === null ? (
            <p>
              The working tree matches <span className="font-mono text-ink">HEAD</span>.
              Agent checkouts start from that commit, so an agent&apos;s work appears
              when you pick its chip — not here, unless it never isolated.
            </p>
          ) : (
            <p>
              This agent&apos;s worktree matches{" "}
              <span className="font-mono text-ink">HEAD</span>. Nothing written yet, or
              everything it wrote is committed on its branch.
            </p>
          )}
        </Centred>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {chips}
      {header}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-1.5">
          {diff.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              active={file.path === selected}
              onSelect={() => void selectFile(project.id, file)}
            />
          ))}
        </div>

        {selected === null ? (
          <Centred>
            <p>Pick a file to see what changed in it.</p>
          </Centred>
        ) : isLoadingBody ? (
          <Centred>
            <p>Reading {selected}…</p>
          </Centred>
        ) : body.trim() === "" ? (
          <Centred>
            <p>
              git reports <span className="font-mono text-ink">{selected}</span> as changed
              but prints no diff for it. That happens when only its mode changed, or when
              it is a binary file.
            </p>
          </Centred>
        ) : (
          <DiffBody body={body} />
        )}
      </div>
    </div>
  );
}
