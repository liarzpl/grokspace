import { useEffect, useState } from "react";

import { errorMessage } from "../lib/api";
import { lockGraphTitles, unlockGraphTitles } from "../lib/graph";
import { isKeyboardClick } from "../lib/keyboardClick";
import { moveSegmented } from "../lib/segmented";
import {
  canApproveSteps,
  MAX_STEPS,
  sendApproval,
  sessionsWithSteps,
  STEPS_MODE_LABEL,
  STEPS_MODES,
  stepProgress,
  stepsMode,
  type StepsMode,
} from "../lib/steps";
import { sessionStatusPhrase } from "../lib/statusText";
import { choiceOptionClass } from "../lib/ui";
import { graphFor, useGraphStore } from "../stores/graphStore";
import { useSessionStore } from "../stores/sessionStore";
import { stepsFor, useStepStore } from "../stores/stepStore";
import type { Session, SessionStep, StepStatus } from "../types";
import AgentTranscript from "./AgentTranscript";
import { SkillHint } from "./SkillHint";
import { QuietButton, StatusDot } from "./ui";

const STEP_MARK: Record<StepStatus, { glyph: string; tone: string; title: string }> = {
  pending: { glyph: "○", tone: "text-ink-faint", title: "Pending" },
  doing: { glyph: "●", tone: "text-accent", title: "Doing" },
  done: { glyph: "✓", tone: "text-success", title: "Done" },
  skipped: { glyph: "–", tone: "text-ink-faint", title: "Skipped" },
};

function nextStatus(status: StepStatus): StepStatus {
  if (status === "pending") return "doing";
  if (status === "doing") return "done";
  return "pending";
}

function StepRow({
  step,
  index,
  total,
}: {
  step: SessionStep;
  index: number;
  total: number;
}) {
  const update = useStepStore((state) => state.update);
  const remove = useStepStore((state) => state.remove);
  const reorder = useStepStore((state) => state.reorder);
  const [editing, setEditing] = useState<string | null>(null);

  const mark = STEP_MARK[step.status] ?? STEP_MARK.pending;

  const move = (delta: number) => {
    const ids = useStepStore
      .getState()
      .bySession[step.sessionId]?.steps.map((item) => item.id);
    if (ids === undefined) return;
    const at = ids.indexOf(step.id);
    const next = at + delta;
    if (at < 0 || next < 0 || next >= ids.length) return;
    const reordered = [...ids];
    const [moved] = reordered.splice(at, 1);
    if (moved === undefined) return;
    reordered.splice(next, 0, moved);
    void reorder(step.sessionId, reordered);
  };

  const commitTitle = () => {
    const next = editing;
    setEditing(null);
    if (next !== null && next.trim() !== "" && next !== step.title) {
      void update(step.id, { title: next });
    }
  };

  return (
    <li className="flex items-start gap-1 rounded-sm px-0.5 py-0.5">
      <button
        type="button"
        title={`${mark.title} · click to cycle`}
        aria-label={`${mark.title}. Click to cycle`}
        onClick={() => void update(step.id, { status: nextStatus(step.status) })}
        className={`mt-0.5 w-4 shrink-0 text-center font-mono text-[11px] ${mark.tone}`}
      >
        {mark.glyph}
      </button>

      {editing !== null ? (
        <input
          autoFocus
          value={editing}
          aria-label="Step title"
          onChange={(event) => setEditing(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTitle();
            if (event.key === "Escape") setEditing(null);
          }}
          className="selectable min-w-0 flex-1 rounded-sm border border-accent bg-canvas px-1 py-0.5 text-[11px] text-ink focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onDoubleClick={() => setEditing(step.title)}
          onClick={(event) => {
            if (isKeyboardClick(event)) setEditing(step.title);
          }}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault();
              setEditing(step.title);
            }
          }}
          aria-label={`Rename step: ${step.title}`}
          title="Rename (Enter or F2). Double-click also works."
          className={`min-w-0 flex-1 text-left text-[11px] leading-snug ${
            step.status === "done" || step.status === "skipped"
              ? "text-ink-faint line-through"
              : "text-ink"
          }`}
        >
          {step.title}
        </button>
      )}

      <div className="flex shrink-0 items-center">
        <QuietButton
          label="▲"
          title="Move up"
          disabled={index === 0}
          onClick={() => move(-1)}
        />
        <QuietButton
          label="▼"
          title="Move down"
          disabled={index >= total - 1}
          onClick={() => move(1)}
        />
        <QuietButton label="Edit" title="Rename this step" onClick={() => setEditing(step.title)} />
        <QuietButton
          label="Skip"
          disabled={step.status === "skipped"}
          onClick={() => void update(step.id, { status: "skipped" })}
        />
        <QuietButton label="×" title="Delete" onClick={() => void remove(step.id)} />
      </div>
    </li>
  );
}

function AddStep({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const add = useStepStore((state) => state.add);
  const [title, setTitle] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (title.trim() === "") return;
    if (await add(sessionId, title)) setTitle("");
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex shrink-0 gap-1">
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={disabled}
        aria-label="Step title"
        placeholder="Add a step…"
        className="selectable min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:opacity-40"
      />
      {title.trim() !== "" && (
        <button
          type="submit"
          disabled={disabled}
          className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Add
        </button>
      )}
    </form>
  );
}

function liveSession(session: Session): Session {
  return (
    useSessionStore.getState().sessions.find((candidate) => candidate.id === session.id) ??
    session
  );
}

function StepsModeChip({
  session,
  mode,
  canBuild,
  building,
  onBuild,
  onSpec,
}: {
  session: Session;
  mode: StepsMode;
  canBuild: boolean;
  building: boolean;
  onBuild: () => void;
  onSpec: () => void;
}) {
  const choose = (next: StepsMode) => {
    if (building || next === mode) return;
    if (next === "spec") onSpec();
    else if (canBuild) onBuild();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Spec or Build"
      onKeyDown={(event) =>
        moveSegmented(
          event,
          STEPS_MODES,
          mode,
          choose,
          (option) => `steps-mode-${session.id}-${option}`,
        )
      }
      className="flex items-center gap-0.5 self-start rounded-md border border-line p-0.5"
    >
      {STEPS_MODES.map((option) => {
        const active = option === mode;
        const disabled = building || (option === "build" && !canBuild && !active);
        const label =
          option === "build" && building ? "Building…" : STEPS_MODE_LABEL[option];
        return (
          <button
            key={option}
            id={`steps-mode-${session.id}-${option}`}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            title={
              option === "spec"
                ? active
                  ? "This list is Spec — titles can still change"
                  : "Reopen Spec so titles can change again"
                : active
                  ? "This list is locked"
                  : canBuild
                    ? "Lock this list and tell the agent to continue"
                    : session.kind === "agent"
                      ? "The agent is still working; Build when it is idle."
                      : "That session is not running."
            }
            onClick={() => choose(option)}
            className={choiceOptionClass(active)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The checklist for one session. Edits live in SQLite and go back to the agent
 * as the Approve prompt, not by rewriting the file the agent is writing.
 *
 * Spec | Build is the visible name for `proposed` | `approved`. Build still
 * calls `sendApproval`. Spec on an approved list Reopens.
 */
export default function SessionSteps({
  session,
  compact = false,
}: {
  session: Session;
  compact?: boolean;
}) {
  const entry = useStepStore((state) => stepsFor(state.bySession, session.id));
  const load = useStepStore((state) => state.load);
  const approve = useStepStore((state) => state.approve);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    if (!(session.id in useStepStore.getState().bySession)) {
      void load(session.id);
    }
  }, [session.id, load]);

  const progress = stepProgress(entry.steps);
  const mode = stepsMode(entry.phase);
  const canApprove = canApproveSteps(session, entry.phase, entry.steps.length);
  const atCap = entry.steps.length >= MAX_STEPS;

  const onBuild = async () => {
    const live = liveSession(session);
    const latest = stepsFor(useStepStore.getState().bySession, live.id);
    if (!canApproveSteps(live, latest.phase, latest.steps.length)) return;

    setApproving(true);
    try {
      const frozen = await approve(live.id);
      if (frozen === null) return;
      lockGraphTitles(live.id, graphFor(useGraphStore.getState().bySession, live.id).graph);
      await sendApproval(live, frozen.steps);
    } catch (error) {
      unlockGraphTitles(live.id);
      await useStepStore.getState().reopen(live.id);
      useStepStore.getState().setError(errorMessage(error));
    } finally {
      setApproving(false);
    }
  };

  const onSpec = async () => {
    const live = liveSession(session);
    const latest = stepsFor(useStepStore.getState().bySession, live.id);
    if (stepsMode(latest.phase) !== "build") return;
    await useStepStore.getState().reopen(live.id);
    unlockGraphTitles(live.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2">
      <div className="flex shrink-0 items-baseline gap-1.5">
        <h2 className="text-[11px] font-medium text-ink-muted">Steps</h2>
        {progress !== null && (
          <span className="font-mono text-[10px] text-ink-faint">
            {progress.done}/{progress.total}
          </span>
        )}
        <div className="flex-1" />
        {mode !== null && entry.steps.length > 0 && (
          <StepsModeChip
            session={session}
            mode={mode}
            canBuild={canApprove}
            building={approving}
            onBuild={() => void onBuild()}
            onSpec={() => void onSpec()}
          />
        )}
      </div>

      {entry.steps.length === 0 && !entry.isLoading ? (
        <div className="flex flex-col gap-2 px-0.5 py-1">
          <p className="text-[11px] leading-snug text-ink-faint">
            The agent has not proposed steps yet.
          </p>
          {!compact && (
            <SkillHint
              id="steps"
              installLabel="Install the steps skill"
              updateLabel="Update the steps skill"
              currentLabel="The steps skill is installed, so agents started from now on write a list before they work."
            />
          )}
        </div>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto">
          {entry.steps.map((step, index) => (
            <StepRow key={step.id} step={step} index={index} total={entry.steps.length} />
          ))}
        </ol>
      )}

      <AddStep sessionId={session.id} disabled={atCap} />
    </div>
  );
}

function sessionLabel(session: Session): string {
  const pane = session.paneId === null ? "" : `${Number(session.paneId) + 1} · `;
  return `${pane}${session.title ?? "Session"}`;
}

/**
 * The left rail on the Tasks tab: this project's Grok and agent sessions, and
 * the step list of the one selected.
 */
export function SessionStepsRail({
  sessions,
  selected,
  onSelect,
}: {
  sessions: Session[];
  selected: Session | undefined;
  onSelect: (sessionId: string) => void;
}) {
  const capable = sessionsWithSteps(sessions);

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-line">
      <div
        role="radiogroup"
        aria-label="Session steps"
        className="flex shrink-0 flex-col gap-1 overflow-x-auto border-b border-line px-2 py-1.5"
      >
        {capable.length === 0 ? (
          <p className="px-0.5 text-[10px] leading-snug text-ink-faint">
            Start a Grok agent to see its steps here.
          </p>
        ) : (
          capable.map((session) => (
            <button
              key={session.id}
              type="button"
              role="radio"
              aria-checked={session.id === selected?.id}
              onClick={() => onSelect(session.id)}
              aria-label={`${sessionLabel(session)}, ${sessionStatusPhrase(session.status)}`}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-left text-[11px] transition-colors ${
                session.id === selected?.id
                  ? "border-accent bg-accent-soft text-ink"
                  : "border-line text-ink-faint hover:border-line-strong hover:text-ink-muted"
              }`}
            >
              <StatusDot status={session.status} />
              <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
              <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                {sessionStatusPhrase(session.status)}
              </span>
              <StepTally sessionId={session.id} />
            </button>
          ))
        )}
      </div>
      {selected && sessionsWithSteps([selected]).length === 1 ? (
        <SessionSteps session={selected} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-[11px] leading-snug text-ink-faint">
            The agent has not proposed steps yet.
          </p>
        </div>
      )}
      {selected?.kind === "agent" && <AgentTranscript session={selected} />}
    </aside>
  );
}

function StepTally({ sessionId }: { sessionId: string }) {
  const steps = useStepStore((state) => stepsFor(state.bySession, sessionId).steps);
  const progress = stepProgress(steps);
  if (progress === null) return null;
  return (
    <span className="shrink-0 font-mono text-[10px] text-ink-faint">
      {progress.done}/{progress.total}
    </span>
  );
}

export { SessionSteps };
