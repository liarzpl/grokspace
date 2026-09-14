import { useEffect, useMemo, useState } from "react";

import { errorMessage } from "../lib/api";
import {
  CHECKPOINT_EQUALS_HEAD,
  DISCARD_REVERTS_CHECKPOINT,
} from "../lib/checkpoint";
import {
  canSendComments,
  commentsPrompt,
  type DiffComment,
  splitDiff,
} from "../lib/diffPrompt";
import { talkToSession } from "../lib/talkToSession";
import {
  INITIAL_DIFF_LINES,
  growVisible,
  lineCount,
  windowHunks,
  windowLines,
} from "../lib/diffWindow";
import {
  overlapFor,
  overlapMarkTitle,
  overlapStrip,
  overlapsOf,
  walkEnabled,
  walkFiles,
  WALK_ORDER_LABEL,
} from "../lib/overlap";
import {
  isolationNotice,
  isUnisolatedAgent,
  useSessionsForProject,
  useSessionStore,
} from "../stores/sessionStore";
import { useDiffStore } from "../stores/diffStore";
import type { ChangedFile, FileChange, PathOverlap, Project, Session } from "../types";

/**
 * What the agents changed, read out of git.
 *
 * The checkpoint is this worktree's HEAD. Discard reverts it so Close can
 * proceed. Merge commits leftover files on that branch and lands them on the
 * project. When a stopped worktree is scoped, a strip names why Merge would
 * refuse (dirty project, nothing to merge) before a click; a conflict abort
 * lands there too.
 * Shared paths with another worktree (or the project) get a red mark and a
 * warning strip that names the other session — Merge stays clickable. Isolated
 * scopes with overlaps can Walk hotspots, then other overlaps, then the rest;
 * the toggle defaults on, and off is git order. Comments on hunks (path,
 * index, note) stay in the store for that session until they are sent as one
 * follow-up to an idle agent.
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

function lineClass(line: string): string {
  return line.startsWith("+++") || line.startsWith("---")
    ? "text-ink-faint"
    : line.startsWith("@@")
      ? "text-accent"
      : line.startsWith("+")
        ? "text-success"
        : line.startsWith("-")
          ? "text-danger"
          : "text-ink-muted";
}

function DiffLines({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, index) => (
        <div key={index} className={lineClass(line)}>
          {line === "" ? "\u00a0" : line}
        </div>
      ))}
    </>
  );
}

function MoreLines({
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
  const next = growVisible(visible, total) - visible;
  return (
    <button
      type="button"
      onClick={onMore}
      className="mt-2 block w-full rounded-sm px-1.5 py-1 text-left text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted"
    >
      Show {next} more {next === 1 ? "line" : "lines"} ({hidden} hidden)
    </button>
  );
}

const NO_COMMENTS: DiffComment[] = [];

/**
 * One line of a diff, coloured by what it is.
 *
 * Rendered line by line rather than handed to a highlighter: a diff's meaning is
 * carried almost entirely by the first character of each line, and a dependency that
 * knows every language would be a lot of bytes to colour three cases.
 *
 * When `onSelectHunk` is set, each `@@` hunk is a click target so a follow-up
 * prompt can name one change rather than the whole file.
 */
function DiffBody({
  body,
  selectedHunk,
  onSelectHunk,
}: {
  body: string;
  selectedHunk: number | null;
  onSelectHunk: ((index: number) => void) | null;
}) {
  const [visible, setVisible] = useState(INITIAL_DIFF_LINES);
  const total = lineCount(body);

  useEffect(() => {
    setVisible(INITIAL_DIFF_LINES);
  }, [body]);

  if (onSelectHunk === null) {
    const windowed = windowLines(body, visible);
    return (
      <pre className="selectable min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed">
        <DiffLines text={windowed.text} />
        <MoreLines
          hidden={windowed.hidden}
          visible={visible}
          total={total}
          onMore={() => setVisible((current) => growVisible(current, total))}
        />
      </pre>
    );
  }

  const { prelude, hunks } = splitDiff(body);
  const windowed = windowHunks(prelude, hunks, visible);

  return (
    <pre className="selectable min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed">
      {windowed.prelude !== "" && <DiffLines text={windowed.prelude} />}
      {windowed.hunks.map((hunk, index) => (
        <button
          key={index}
          type="button"
          onClick={() => onSelectHunk(index)}
          className={`block w-full text-left ${
            selectedHunk === index ? "bg-accent-soft" : "hover:bg-elevated"
          }`}
        >
          <DiffLines text={hunk} />
        </button>
      ))}
      <MoreLines
        hidden={windowed.hidden}
        visible={visible}
        total={total}
        onMore={() => setVisible((current) => growVisible(current, total))}
      />
    </pre>
  );
}

function CommentBar({
  session,
  path,
  hunkIndex,
  hunk,
}: {
  session: Session;
  path: string | null;
  hunkIndex: number | null;
  hunk: string | null;
}) {
  const commentsBySession = useDiffStore((state) => state.comments);
  const addComment = useDiffStore((state) => state.addComment);
  const removeComment = useDiffStore((state) => state.removeComment);
  const clearComments = useDiffStore((state) => state.clearComments);
  const comments = commentsBySession[session.id] ?? NO_COMMENTS;
  const [sentence, setSentence] = useState("");
  const canAdd =
    path !== null && hunkIndex !== null && hunk !== null && sentence.trim() !== "";
  const canSend = canSendComments(session, comments);

  const add = () => {
    if (path === null || hunkIndex === null || hunk === null) return;
    addComment(session.id, { path, hunkIndex, text: sentence, hunk });
    setSentence("");
  };

  const send = () => {
    if (!canSend) return;
    void (async () => {
      try {
        await talkToSession(session, commentsPrompt(comments));
        clearComments(session.id);
      } catch (error) {
        useDiffStore.setState({ error: errorMessage(error) });
      }
    })();
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-line px-3 py-1.5">
      {hunk !== null && path !== null && hunkIndex !== null && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={sentence}
            aria-label="Ask about this hunk"
            onChange={(event) => setSentence(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            placeholder="Comment on this hunk…"
            className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
          />
          <button
            type="button"
            onClick={add}
            disabled={!canAdd}
            className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted disabled:opacity-40"
          >
            Add comment
          </button>
        </div>
      )}
      {comments.length > 0 && (
        <>
          <ul className="flex flex-col gap-0.5">
            {comments.map((comment) => (
              <li
                key={`${comment.path}:${comment.hunkIndex}`}
                className="flex items-baseline gap-2 text-[11px] text-ink-muted"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono text-ink">{comment.path}</span>
                  {" · hunk "}
                  {comment.hunkIndex + 1}
                  {": "}
                  {comment.text}
                </span>
                <button
                  type="button"
                  aria-label={`Remove comment on ${comment.path} hunk ${comment.hunkIndex + 1}`}
                  onClick={() => removeComment(session.id, comment.path, comment.hunkIndex)}
                  className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              title={canSend ? "Send every open comment to this agent" : "Agent has to be idle"}
              className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted disabled:opacity-40"
            >
              Send to idle agent
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * POSIX path that stays LTR for AT (A11Y-010 / WP-29).
 *
 * The old `[direction:rtl]` + `truncate` trick kept the file name in view but
 * put the path itself in the RTL accessibility tree, so VoiceOver could read
 * `src/lib/api.ts` backwards. Clip the directory instead: the name identifies
 * the row, and the tree is `dir="ltr"`.
 */
function FilePath({ path, className }: { path: string; className: string }) {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);

  return (
    <span dir="ltr" className={`flex min-w-0 flex-1 text-left text-[11px] ${className}`}>
      {dir !== "" && <span className="min-w-0 truncate">{dir}</span>}
      <span className="max-w-full shrink-0 truncate">{name}</span>
    </span>
  );
}

function FileRow({
  file,
  active,
  overlap,
  onSelect,
}: {
  file: ChangedFile;
  active: boolean;
  overlap: PathOverlap | undefined;
  onSelect: () => void;
}) {
  const mark = overlap !== undefined ? overlapMarkTitle(overlap) : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={mark === null ? file.path : `${file.path} — ${mark}`}
      className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left transition-colors ${
        active ? "bg-accent-soft" : "hover:bg-elevated"
      }`}
    >
      <span className={`shrink-0 font-mono text-[10px] ${CHANGE_TONE[file.change]}`}>
        {CHANGE_LABEL[file.change]}
      </span>
      {mark !== null && (
        <span aria-label={mark} className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-danger" />
      )}
      <FilePath
        path={file.path}
        className={overlap?.hotspot === true ? "text-danger" : "text-ink-muted"}
      />
    </button>
  );
}

function sessionLabel(session: Session): string {
  return session.title ?? "Agent";
}

/**
 * Why Merge will refuse this scoped, stopped worktree.
 *
 * Pre-checks (dirty project, nothing to merge, missing git) are read-only.
 * A conflict abort only exists after click, and is written onto the same
 * field so it is not only a toast at the bottom of the window.
 */
function MergeReadinessStrip({ sessionId }: { sessionId: string }) {
  const reason = useSessionStore((state) => state.mergeReasons[sessionId]);
  const inspectMerge = useSessionStore((state) => state.inspectMerge);
  const diff = useDiffStore((state) => state.diff);

  useEffect(() => {
    void inspectMerge(sessionId);
  }, [sessionId, inspectMerge, diff]);

  if (reason == null || reason === "") return null;

  return (
    <div
      role="status"
      className="shrink-0 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] leading-relaxed text-danger"
    >
      {reason}
    </div>
  );
}

/**
 * Shared paths with another worktree or the project. Warning, not a refusal:
 * Merge stays clickable. Lockfiles and migrations use the same strip with a
 * louder sentence.
 */
function OverlapStrip({ overlaps }: { overlaps: PathOverlap[] }) {
  const text = overlapStrip(overlaps);
  if (text === null) return null;
  const loud = overlaps.some((item) => item.hotspot);

  return (
    <div
      role="status"
      className={`shrink-0 border-b px-3 py-1.5 text-[11px] leading-relaxed ${
        loud
          ? "border-warning/60 bg-warning/15 text-warning"
          : "border-warning/40 bg-warning/10 text-warning"
      }`}
    >
      {text}
    </div>
  );
}

function ScopeChips({
  projectId,
  sessions,
  unisolated,
  scope,
  overlaps,
  onSelect,
}: {
  projectId: string;
  sessions: Session[];
  unisolated: Session[];
  scope: string | null;
  overlaps: PathOverlap[];
  onSelect: (sessionId: string | null) => void;
}) {
  const reasons = useSessionStore((state) => state.isolationReasons);
  const scoped = sessions.find((session) => session.id === scope);
  const mergeReason = useSessionStore((state) =>
    scoped !== undefined ? state.mergeReasons[scoped.id] : undefined,
  );

  if (sessions.length === 0 && unisolated.length === 0) return null;

  const stopped = scoped?.status === "stopped";

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 py-1.5">
        <div role="radiogroup" aria-label="Diff scope" className="flex items-center gap-1">
        <button
          type="button"
          role="radio"
          aria-checked={scope === null}
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
            role="radio"
            aria-checked={scope === session.id}
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
        </div>
        {unisolated.map((session) => (
          <span
            key={session.id}
            title={isolationNotice(session, reasons[session.id])}
            className="shrink-0 rounded-md border border-warning/40 px-2 py-0.5 text-[11px] text-warning"
          >
            {sessionLabel(session)} · project tree
          </span>
        ))}
        <div className="flex-1" />
        {stopped && scoped !== undefined && (
          <>
            <button
              type="button"
              title={
                mergeReason != null && mergeReason !== ""
                  ? mergeReason
                  : (overlapStrip(overlaps) ?? "Merge this agent's branch into the project")
              }
              onClick={() => {
                void (async () => {
                  await useSessionStore.getState().mergeWorktree(scoped.id);
                  const leftover = useSessionStore
                    .getState()
                    .sessions.find((session) => session.id === scoped.id);
                  if (leftover?.worktreePath === null) {
                    await useDiffStore.getState().loadDiff(projectId, null);
                  }
                })();
              }}
              className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted"
            >
              Merge
            </button>
            <button
              type="button"
              title={DISCARD_REVERTS_CHECKPOINT}
              onClick={() => {
                void (async () => {
                  await useSessionStore.getState().discardWorktree(scoped.id);
                  const leftover = useSessionStore
                    .getState()
                    .sessions.find((session) => session.id === scoped.id);
                  if (leftover?.worktreePath === null) {
                    await useDiffStore.getState().loadDiff(projectId, null);
                  }
                })();
              }}
              className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted"
            >
              Discard
            </button>
          </>
        )}
      </div>
      {stopped && scoped !== undefined && <MergeReadinessStrip sessionId={scoped.id} />}
      <OverlapStrip overlaps={overlaps} />
    </>
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
  const commentsBySession = useDiffStore((state) => state.comments);
  const projectSessions = useSessionsForProject(project.id);
  const sessions = useMemo(
    () => projectSessions.filter((session) => session.worktreePath !== null),
    [projectSessions],
  );
  const unisolated = useMemo(
    () => projectSessions.filter(isUnisolatedAgent),
    [projectSessions],
  );
  const [hunkIndex, setHunkIndex] = useState<number | null>(null);
  const [walkOn, setWalkOn] = useState(true);

  useEffect(() => {
    void loadDiff(project.id, null);
  }, [project.id, loadDiff]);

  useEffect(() => {
    setHunkIndex(null);
  }, [body, selected, scope]);

  const scoped = sessions.some((session) => session.id === scope) ? scope : null;
  const scopedSession = sessions.find((session) => session.id === scoped) ?? null;
  const hunks = scoped === null ? [] : splitDiff(body).hunks;
  const selectedHunk = hunkIndex === null ? null : (hunks[hunkIndex] ?? null);
  const scopedComments =
    scoped === null ? NO_COMMENTS : (commentsBySession[scoped] ?? NO_COMMENTS);
  const overlaps = overlapsOf(diff);
  const walking = walkEnabled(scoped !== null, overlaps, walkOn);
  const listed = diff.state === "changed" ? walkFiles(diff.files, overlaps, walking) : [];

  useEffect(() => {
    setWalkOn(true);
  }, [scoped]);

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
      {scoped !== null && (
        <span className="text-[10px] text-ink-faint">{CHECKPOINT_EQUALS_HEAD}</span>
      )}
      <div className="flex-1" />
      {diff.state === "changed" && overlaps.length > 0 && scoped !== null && (
        <button
          type="button"
          role="switch"
          aria-checked={walkOn}
          aria-label={WALK_ORDER_LABEL}
          title={WALK_ORDER_LABEL}
          onClick={() => setWalkOn((on) => !on)}
          className={`rounded-sm px-1.5 py-0.5 text-[10px] transition-colors ${
            walkOn
              ? "bg-accent-soft text-ink"
              : "text-ink-faint hover:bg-elevated hover:text-ink-muted"
          }`}
        >
          Walk
        </button>
      )}
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
      unisolated={unisolated}
      scope={scoped}
      overlaps={overlaps}
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
        <div
          dir="ltr"
          className="flex w-64 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-1.5"
        >
          {listed.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              active={file.path === selected}
              overlap={overlapFor(overlaps, file.path)}
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
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <DiffBody
              body={body}
              selectedHunk={hunkIndex}
              onSelectHunk={scoped === null ? null : setHunkIndex}
            />
          </div>
        )}
      </div>
      {scopedSession !== null && (selectedHunk !== null || scopedComments.length > 0) && (
        <CommentBar
          session={scopedSession}
          path={selected}
          hunkIndex={hunkIndex}
          hunk={selectedHunk}
        />
      )}
    </div>
  );
}
