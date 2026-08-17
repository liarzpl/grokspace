import { useState } from "react";

import { layoutOf } from "../stores/projectStore";
import { sessionForPane, useSessionStore } from "../stores/sessionStore";
import { tasksInColumn, useTaskStore } from "../stores/taskStore";
import { paneCount, type Project, type Session, type Task, type TaskStatus } from "../types";

/** The four columns, left to right. */
const COLUMNS: readonly { status: TaskStatus; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

/**
 * The drag payload is a task id under a private type, so a file dragged in from
 * the desktop cannot be mistaken for a card.
 */
const TASK_MIME = "application/x-grokspace-task";

/** An agent already running, or a free pane one could be started in. */
type DispatchTarget =
  | { kind: "session"; session: Session }
  | { kind: "pane"; paneId: string };

function targetKey(target: DispatchTarget): string {
  return target.kind === "session" ? target.session.id : `pane-${target.paneId}`;
}

function targetLabel(target: DispatchTarget): string {
  if (target.kind === "pane") return `${Number(target.paneId) + 1} · Start Grok`;
  const pane = target.session.paneId === null ? "" : `${Number(target.session.paneId) + 1} · `;
  return `${pane}${target.session.title ?? "Session"}`;
}

/**
 * Where a task can be sent, in pane order so the row reads like the grid does.
 *
 * A pane holding a stopped session is not offered: restarting it is a decision
 * about that terminal, not about this task. Nor is a shell, which would try to run
 * the task as a command rather than read it.
 */
function dispatchTargets(project: Project, sessions: Session[]): DispatchTarget[] {
  const panes = Array.from({ length: paneCount(layoutOf(project)) }, (_, index) =>
    String(index),
  );

  return panes.flatMap((paneId): DispatchTarget[] => {
    const session = sessionForPane(sessions, paneId);
    if (session === undefined) return [{ kind: "pane", paneId }];
    if (session.kind === "grok" && session.status === "running") {
      return [{ kind: "session", session }];
    }
    return [];
  });
}

/**
 * Whether a drag that is leaving actually left.
 *
 * `dragleave` also fires when the pointer crosses into a child element, which
 * would make a highlight flicker over every card in the column.
 */
function reallyLeft(event: React.DragEvent<HTMLElement>): boolean {
  return !event.currentTarget.contains(event.relatedTarget as Node | null);
}

function NewTaskForm({ projectId }: { projectId: string }) {
  const createTask = useTaskStore((state) => state.createTask);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (title.trim() === "") return;
    const created = await createTask(projectId, title, description);
    if (created !== null) {
      setTitle("");
      setDescription("");
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex shrink-0 flex-col gap-1">
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Add a task…"
        className="selectable w-full rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      {/* Only once there is a task to describe, so the column is not two inputs deep
          when nobody is adding anything. */}
      {title.trim() !== "" && (
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Context for the agent (optional)"
          className="selectable w-full rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
      )}
    </form>
  );
}

function CardButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-sm px-1 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function TaskCard({
  task,
  targets,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  targets: DispatchTarget[];
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
}) {
  const dispatch = useTaskStore((state) => state.dispatch);
  const dispatchToNewSession = useTaskStore((state) => state.dispatchToNewSession);
  const editTask = useTaskStore((state) => state.editTask);
  const removeTask = useTaskStore((state) => state.removeTask);
  const busy = useTaskStore((state) => state.dispatching[task.id] ?? false);
  const assigned = useSessionStore((state) =>
    state.sessions.find((session) => session.id === task.assignedSessionId),
  );

  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const send = (target: DispatchTarget) => {
    setChoosing(false);
    if (target.kind === "session") void dispatch(task.id, target.session.id);
    else void dispatchToNewSession(task.id, task.projectId, target.paneId);
  };

  const commitTitle = () => {
    const next = editing;
    setEditing(null);
    if (next !== null && next.trim() !== "" && next !== task.title) {
      void editTask(task.id, { title: next });
    }
  };

  return (
    <div
      draggable={editing === null}
      onDragStart={(event) => {
        event.dataTransfer.setData(TASK_MIME, task.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart(task.id);
      }}
      onDragEnd={onDragEnd}
      className="group shrink-0 cursor-grab rounded-md border border-line bg-panel p-2 transition-colors hover:border-line-strong active:cursor-grabbing"
    >
      {editing !== null ? (
        <input
          autoFocus
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTitle();
            if (event.key === "Escape") setEditing(null);
          }}
          className="selectable w-full rounded-sm border border-accent bg-canvas px-1 py-0.5 text-[11px] text-ink focus:outline-none"
        />
      ) : (
        <p
          onDoubleClick={() => setEditing(task.title)}
          title="Double-click to rename"
          className="text-[11px] leading-snug text-ink"
        >
          {task.title}
        </p>
      )}

      {task.description !== null && (
        <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-ink-faint">
          {task.description}
        </p>
      )}

      {assigned !== undefined && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-ink-muted">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              assigned.status === "running" ? "bg-accent" : "bg-line-strong"
            }`}
          />
          {targetLabel({ kind: "session", session: assigned })}
        </p>
      )}

      {/* Shown on hover or while this card is mid-interaction, so a full column is
          a list of tasks rather than a wall of controls. */}
      <div
        className={`mt-1.5 flex items-center gap-0.5 transition-opacity ${
          choosing || busy ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <CardButton
          label={busy ? "Dispatching…" : choosing ? "Cancel" : "Dispatch"}
          disabled={busy}
          onClick={() => setChoosing(!choosing)}
        />
        <div className="flex-1" />
        <CardButton label="Delete" onClick={() => void removeTask(task.id)} />
      </div>

      {choosing && (
        <div className="mt-1 flex flex-col items-start gap-0.5 border-t border-line pt-1">
          {targets.length === 0 ? (
            <p className="text-[10px] leading-snug text-ink-faint">
              No agent is running and no pane is free.
            </p>
          ) : (
            targets.map((target) => (
              <CardButton
                key={targetKey(target)}
                label={targetLabel(target)}
                onClick={() => send(target)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TaskColumn({
  status,
  label,
  tasks,
  targets,
  dragging,
  onDragStart,
  onDragEnd,
  projectId,
}: {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  targets: DispatchTarget[];
  dragging: boolean;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  projectId: string;
}) {
  const moveTask = useTaskStore((state) => state.moveTask);
  const [over, setOver] = useState(false);

  return (
    <div
      onDragEnter={() => dragging && setOver(true)}
      onDragLeave={(event) => reallyLeft(event) && setOver(false)}
      onDragOver={(event) => {
        // Without preventDefault the browser refuses the drop entirely.
        if (!dragging) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        setOver(false);
        const taskId = event.dataTransfer.getData(TASK_MIME);
        if (taskId === "") return;
        event.preventDefault();
        // A card dropped back where it started is a no-op, not a round trip.
        if (tasks.some((task) => task.id === taskId)) return;
        void moveTask(taskId, status);
      }}
      className={`flex min-h-0 flex-col gap-1.5 rounded-md border p-1.5 transition-colors ${
        over ? "border-accent bg-accent-soft" : "border-line bg-canvas"
      }`}
    >
      <div className="flex shrink-0 items-baseline gap-1.5 px-0.5">
        <h2 className="text-[11px] font-medium text-ink-muted">{label}</h2>
        <span className="font-mono text-[10px] text-ink-faint">{tasks.length}</span>
      </div>

      {status === "backlog" && <NewTaskForm projectId={projectId} />}

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            targets={targets}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A drop target per place a task can go, above the columns.
 *
 * Dragging a card onto the pane itself is not possible: the Terminals tab and this
 * one are never on screen together, so the chip stands in for the pane the way the
 * Graph tab's chips stand in for their sessions.
 */
function DispatchRow({
  project,
  targets,
  dragging,
}: {
  project: Project;
  targets: DispatchTarget[];
  dragging: boolean;
}) {
  const dispatch = useTaskStore((state) => state.dispatch);
  const dispatchToNewSession = useTaskStore((state) => state.dispatchToNewSession);
  const [over, setOver] = useState<string | null>(null);

  if (targets.length === 0) return null;

  const drop = (target: DispatchTarget, taskId: string) => {
    if (target.kind === "session") void dispatch(taskId, target.session.id);
    else void dispatchToNewSession(taskId, project.id, target.paneId);
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-1.5">
      <span className="shrink-0 text-[10px] text-ink-faint">Dispatch to</span>
      {targets.map((target) => {
        const key = targetKey(target);
        return (
          <div
            key={key}
            onDragEnter={() => dragging && setOver(key)}
            onDragLeave={(event) => reallyLeft(event) && setOver(null)}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              setOver(null);
              const taskId = event.dataTransfer.getData(TASK_MIME);
              if (taskId === "") return;
              event.preventDefault();
              drop(target, taskId);
            }}
            className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
              over === key
                ? "border-accent bg-accent-soft text-ink"
                : dragging
                  ? "border-line-strong text-ink-muted"
                  : "border-line text-ink-faint"
            }`}
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                target.kind === "session" ? "bg-accent" : "bg-line-strong"
              }`}
            />
            <span className="max-w-40 truncate">{targetLabel(target)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function TaskBoard({ project }: { project: Project }) {
  const tasks = useTaskStore((state) => state.tasks);
  const sessions = useSessionStore((state) => state.sessions);
  const [dragging, setDragging] = useState<string | null>(null);

  const targets = dispatchTargets(project, sessions);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DispatchRow project={project} targets={targets} dragging={dragging !== null} />

      <div className="grid min-h-0 flex-1 grid-cols-4 gap-2 p-2">
        {COLUMNS.map(({ status, label }) => (
          <TaskColumn
            key={status}
            status={status}
            label={label}
            tasks={tasksInColumn(tasks, status)}
            targets={targets}
            dragging={dragging !== null}
            onDragStart={setDragging}
            onDragEnd={() => setDragging(null)}
            projectId={project.id}
          />
        ))}
      </div>
    </div>
  );
}
