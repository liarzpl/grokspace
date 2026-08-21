import { useState } from "react";

import {
  dispatchTargets,
  paneOf,
  targetKey,
  targetLabel,
  type DispatchTarget,
} from "../lib/dispatch";
import { ROLES, rolesInPlay } from "../lib/roles";
import { sessionsWithSteps, stepProgress } from "../lib/steps";
import { useSessionsForProject, useSessionStore } from "../stores/sessionStore";
import { stepsFor, useStepStore } from "../stores/stepStore";
import { tasksInColumn, useTaskStore } from "../stores/taskStore";
import {
  type PermissionRequest,
  type Project,
  type SessionStatus,
  type Task,
  type TaskStatus,
} from "../types";
import { PermissionActions } from "./PermissionActions";
import { SessionStepsRail } from "./SessionSteps";

/** The four columns, left to right. */
const COLUMNS: readonly { status: TaskStatus; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

/**
 * Which card is being dragged is React state, not the drag payload.
 *
 * `dataTransfer` looked like the right place for it and is not: a custom MIME type
 * does not survive the drag in every webview — WebKitGTK hands back an empty
 * string — so a drop read from `getData` silently did nothing. The payload is still
 * set, as `text/plain`, because a drag with nothing in it is refused outright.
 *
 * Reading from state is also the stronger guard. A file dragged in from the desktop
 * never sets this, so it can never be mistaken for a card, and the check happens in
 * `dragover` where refusing costs nothing rather than in `drop` after the fact.
 */
const DRAG_MIME = "text/plain";

/** A stable empty array, so a card with no permissions does not resubscribe forever. */
const EMPTY_PERMISSIONS: readonly PermissionRequest[] = [];

const STATUS_TONE: Record<SessionStatus, string> = {
  running: "bg-accent",
  needs_input: "bg-warning",
  idle: "bg-success",
  stopped: "bg-line-strong",
};

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
      {/* Both only once there is a task to describe, so the column is not three
          controls deep when nobody is adding anything. */}
      {title.trim() !== "" && (
        <>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Context for the agent (optional)"
            className="selectable w-full rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          {/*
            Not decoration: a form with two text fields and no submit button does
            not submit on Enter at all. HTML's implicit submission gives up once
            more than one field blocks it, so without this the description input
            appearing is what would stop the keyboard working.
          */}
          <button
            type="submit"
            className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90"
          >
            Add task
          </button>
        </>
      )}
    </form>
  );
}

function CardButton({
  label,
  title,
  onClick,
  disabled,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-sm px-1 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-elevated hover:text-ink-muted disabled:opacity-30 disabled:hover:bg-transparent"
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
  const moveTask = useTaskStore((state) => state.moveTask);
  const removeTask = useTaskStore((state) => state.removeTask);
  const busy = useTaskStore((state) => state.dispatching[task.id] ?? false);
  const answerPermission = useSessionStore((state) => state.answerPermission);
  const assigned = useSessionStore((state) =>
    state.sessions.find((session) => session.id === task.assignedSessionId),
  );
  // What the agent on this task is blocked on. Shown here rather than in a banner
  // because it is a question about this specific piece of work.
  const pending = useSessionStore((state) =>
    task.assignedSessionId === null ? EMPTY_PERMISSIONS : (state.permissions[task.assignedSessionId] ?? EMPTY_PERMISSIONS),
  );

  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingDesc, setEditingDesc] = useState<string | null>(null);

  const column = COLUMNS.findIndex(({ status }) => status === task.status);

  const moveBy = (step: number) => {
    const next = COLUMNS[column + step];
    if (next !== undefined) void moveTask(task.id, next.status);
  };

  const send = (target: DispatchTarget) => {
    setChoosing(false);
    if (target.kind === "session") void dispatch(task.id, target.session.id);
    // A null pane is what asks for an agent rather than a terminal.
    else void dispatchToNewSession(task.id, task.projectId, paneOf(target));
  };

  const commitTitle = () => {
    const next = editing;
    setEditing(null);
    if (next !== null && next.trim() !== "" && next !== task.title) {
      void editTask(task.id, { title: next });
    }
  };

  const commitDescription = () => {
    const next = editingDesc;
    setEditingDesc(null);
    if (next !== null && next.trim() !== (task.description ?? "")) {
      void editTask(task.id, { description: next });
    }
  };

  return (
    <div
      draggable={editing === null && editingDesc === null}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_MIME, task.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart(task.id);
      }}
      onDragEnd={onDragEnd}
      className="shrink-0 cursor-grab rounded-md border border-line bg-panel p-2 transition-colors hover:border-line-strong active:cursor-grabbing"
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

      {editingDesc !== null ? (
        <input
          autoFocus
          value={editingDesc}
          onChange={(event) => setEditingDesc(event.target.value)}
          onBlur={commitDescription}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitDescription();
            if (event.key === "Escape") setEditingDesc(null);
          }}
          placeholder="Context for the agent (optional)"
          className="selectable mt-1 w-full rounded-sm border border-accent bg-canvas px-1 py-0.5 text-[10px] text-ink focus:outline-none"
        />
      ) : (
        <p
          onDoubleClick={() => setEditingDesc(task.description ?? "")}
          title="Double-click to edit description"
          className="mt-1 line-clamp-2 text-[10px] leading-snug text-ink-faint"
        >
          {task.description ?? "Add description…"}
        </p>
      )}

      {assigned !== undefined && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-ink-muted">
          <span className={`size-1.5 shrink-0 rounded-full ${STATUS_TONE[assigned.status]}`} />
          <span className="min-w-0 truncate">
            {targetLabel({ kind: "session", session: assigned })}
          </span>
          <CardStepTally sessionId={assigned.id} />
          {/* Only an agent has anything to add: a terminal reports `running` and
              nothing else, so naming it would be noise on every card. */}
          {assigned.kind === "agent" && (
            <span className="shrink-0 font-mono text-ink-faint">{assigned.status}</span>
          )}
        </p>
      )}

      {pending.map((request) => (
        <div key={request.requestId} className="mt-1.5 rounded-sm bg-elevated p-1.5">
          <p className="text-[10px] leading-snug text-ink-muted">{request.summary}</p>
          <div className="mt-1">
            <PermissionActions
              request={request}
              onAnswer={(allow, optionId) =>
                void answerPermission(
                  assigned?.id ?? "",
                  request.requestId,
                  allow,
                  optionId,
                )
              }
            />
          </div>
        </div>
      ))}

      {/*
        Always shown rather than revealed on hover. Controls faded to nothing are
        still clickable, which is a trap, and hiding the primary action behind a
        hover is a poor way to let anyone discover it. They are quiet enough at this
        size to read as a footer rather than a wall.
      */}
      <div className="mt-1.5 flex items-center gap-0.5">
        {/* The keyboard-reachable way to change column. Dragging is nicer when it
            works, but it is the one interaction here that depends on the webview's
            drag support, so it must not be the only way across. */}
        <CardButton
          label="◀"
          title={column > 0 ? `Move to ${COLUMNS[column - 1]?.label}` : "Already leftmost"}
          disabled={column <= 0}
          onClick={() => moveBy(-1)}
        />
        <CardButton
          label="▶"
          title={
            column < COLUMNS.length - 1
              ? `Move to ${COLUMNS[column + 1]?.label}`
              : "Already rightmost"
          }
          disabled={column >= COLUMNS.length - 1}
          onClick={() => moveBy(1)}
        />

        <div className="flex-1" />

        <CardButton
          label={busy ? "Dispatching…" : choosing ? "Cancel" : "Dispatch"}
          disabled={busy}
          onClick={() => setChoosing(!choosing)}
        />
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
  draggingId,
  onDragStart,
  onDragEnd,
  projectId,
}: {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  targets: DispatchTarget[];
  draggingId: string | null;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  projectId: string;
}) {
  const moveTask = useTaskStore((state) => state.moveTask);
  const [over, setOver] = useState(false);

  return (
    <div
      onDragEnter={() => draggingId !== null && setOver(true)}
      onDragLeave={(event) => reallyLeft(event) && setOver(false)}
      onDragOver={(event) => {
        // Without preventDefault the browser refuses the drop entirely.
        if (draggingId === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        setOver(false);
        if (draggingId === null) return;
        event.preventDefault();
        // A card dropped back where it started is a no-op, not a round trip.
        if (tasks.some((task) => task.id === draggingId)) return;
        void moveTask(draggingId, status);
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
  draggingId,
}: {
  project: Project;
  targets: DispatchTarget[];
  draggingId: string | null;
}) {
  const dispatch = useTaskStore((state) => state.dispatch);
  const dispatchToNewSession = useTaskStore((state) => state.dispatchToNewSession);
  const [over, setOver] = useState<string | null>(null);

  if (targets.length === 0) return null;

  const drop = (target: DispatchTarget, taskId: string) => {
    if (target.kind === "session") void dispatch(taskId, target.session.id);
    else void dispatchToNewSession(taskId, project.id, paneOf(target));
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-1.5">
      <span className="shrink-0 text-[10px] text-ink-faint">Dispatch to</span>
      {targets.map((target) => {
        const key = targetKey(target);
        return (
          <div
            key={key}
            onDragEnter={() => draggingId !== null && setOver(key)}
            onDragLeave={(event) => reallyLeft(event) && setOver(null)}
            onDragOver={(event) => {
              if (draggingId === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              setOver(null);
              if (draggingId === null) return;
              event.preventDefault();
              drop(target, draggingId);
            }}
            className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
              over === key
                ? "border-accent bg-accent-soft text-ink"
                : draggingId !== null
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

      <div className="flex-1" />
      <SwarmLauncher project={project} />
    </div>
  );
}

/**
 * Starts one agent per chosen role, each told what it is for.
 *
 * Here rather than in its own tab because this is where the sessions that do the
 * work are chosen: the row above already lists what a task can be handed to, and a
 * swarm is how that row gets something worth handing to.
 */
function SwarmLauncher({ project }: { project: Project }) {
  const launchSwarm = useSessionStore((state) => state.launchSwarm);
  const sessions = useSessionsForProject(project.id);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [launching, setLaunching] = useState(false);

  // Which roles are already covered. Without this, pressing the button twice would
  // quietly start a second Planner beside the first — five agents is a decision, and
  // ten by accident is not.
  const running = rolesInPlay(sessions);

  const start = () => {
    // Chosen when the row opens rather than once at mount, so the default reflects
    // what is running now. Everything already covered starts unticked, which means a
    // full swarm reopens with nothing selected — correctly saying there is nothing to
    // add.
    setChosen(ROLES.filter((role) => !running.has(role.name)).map((role) => role.name));
    setOpen(true);
  };

  const toggle = (name: string) =>
    setChosen((current) =>
      current.includes(name) ? current.filter((held) => held !== name) : [...current, name],
    );

  const launch = async () => {
    setLaunching(true);
    // In ROLES order rather than the order they were clicked, so a swarm always
    // starts Planner first and reads the same however it was picked.
    const roles = ROLES.filter((role) => chosen.includes(role.name));
    const failed = await launchSwarm(project.id, roles);
    setLaunching(false);

    // Closed only when every role started. Otherwise the row stays open with just
    // the ones that did not selected, so the retry is one click and does not restart
    // the agents that are already running. The banner says why; this says which.
    if (failed.length === 0) setOpen(false);
    else setChosen(failed);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={start}
        className="shrink-0 rounded-md border border-line-strong px-2 py-0.5 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink"
      >
        Launch a swarm
      </button>
    );
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      {ROLES.map((role) => (
        <button
          key={role.name}
          type="button"
          onClick={() => toggle(role.name)}
          title={running.has(role.name) ? `${role.name} is already running` : role.summary}
          className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
            chosen.includes(role.name)
              ? "border-accent bg-accent-soft text-ink"
              : "border-line text-ink-faint hover:border-line-strong hover:text-ink-muted"
          }`}
        >
          {role.name}
          {/* Still tickable: a second Reviewer is a reasonable thing to want, just not
              something to get by accident. */}
          {running.has(role.name) && <span className="ml-1 text-ink-faint">·on</span>}
        </button>
      ))}
      <button
        type="button"
        onClick={() => void launch()}
        disabled={launching || chosen.length === 0}
        className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {launching ? "Starting…" : `Start ${chosen.length}`}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-sm px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:text-ink-muted"
      >
        Cancel
      </button>
    </div>
  );
}

function CardStepTally({ sessionId }: { sessionId: string }) {
  const steps = useStepStore((state) => stepsFor(state.bySession, sessionId).steps);
  const progress = stepProgress(steps);
  if (progress === null) return null;
  return (
    <span className="shrink-0 font-mono text-ink-faint">
      {progress.done}/{progress.total}
    </span>
  );
}

export default function TaskBoard({ project }: { project: Project }) {
  const tasks = useTaskStore((state) => state.tasks);
  const sessions = useSessionsForProject(project.id);
  const [dragging, setDragging] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const targets = dispatchTargets(project, sessions);
  const capable = sessionsWithSteps(sessions);
  const selected =
    capable.find((session) => session.id === selectedId) ?? capable[0] ?? undefined;

  return (
    <div className="flex min-h-0 flex-1">
      <SessionStepsRail sessions={sessions} selected={selected} onSelect={setSelectedId} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DispatchRow project={project} targets={targets} draggingId={dragging} />

        <div className="grid min-h-0 flex-1 grid-cols-4 gap-2 p-2">
          {COLUMNS.map(({ status, label }) => (
            <TaskColumn
              key={status}
              status={status}
              label={label}
              tasks={tasksInColumn(tasks, status)}
              targets={targets}
              draggingId={dragging}
              onDragStart={setDragging}
              onDragEnd={() => setDragging(null)}
              projectId={project.id}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
