import { createContext, useContext, useState } from "react";

import {
  dispatchTargets,
  paneOf,
  targetKey,
  targetLabel,
  type DispatchTarget,
} from "../lib/dispatch";
import { isKeyboardClick } from "../lib/keyboardClick";
import { ROLES, rolesInPlay } from "../lib/roles";
import { sessionsWithSteps, stepProgress } from "../lib/steps";
import { sessionStatusPhrase } from "../lib/statusText";
import { useSessionsForProject, useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { stepsFor, useStepStore } from "../stores/stepStore";
import {
  DISPATCH_ANYWAY,
  inboxZeroBlockReason,
  needsYouWaiting,
  tasksInColumn,
  typedDispatchAnyway,
  useTaskStore,
  useTasksForProject,
} from "../stores/taskStore";
import { useUiStore } from "../stores/uiStore";
import {
  type PermissionRequest,
  type Project,
  type Task,
  type TaskStatus,
} from "../types";
import { PermissionActions } from "./PermissionActions";
import { SessionStepsRail } from "./SessionSteps";
import { QuietButton, StatusDot } from "./ui";

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

/** Shared by cards and the drop row so a typed override is one field, not a checkbox. */
type DispatchGate = {
  blocked: boolean;
  blockReason: string | null;
  anyway: boolean;
  onDispatched: () => void;
};

const OPEN_GATE: DispatchGate = {
  blocked: false,
  blockReason: null,
  anyway: false,
  onDispatched: () => {},
};

const DispatchGateContext = createContext<DispatchGate>(OPEN_GATE);

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
        aria-label="Task title"
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
            aria-label="Task description"
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
  const { blocked, blockReason, anyway, onDispatched } = useContext(DispatchGateContext);
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
  const pending = useUiStore((state) =>
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
    if (blocked) return;
    setChoosing(false);
    const options = { anyway };
    onDispatched();
    if (target.kind === "session") void dispatch(task.id, target.session.id, options);
    // A null pane is what asks for an agent rather than a terminal.
    else void dispatchToNewSession(task.id, task.projectId, paneOf(target), options);
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
    if (next === null) return;
    // Trim so whitespace-only becomes the `""` clear sentinel `update_task`
    // treats as SQL NULL. Sending the untrimmed string would also clear, but
    // the board's comparison is on the trimmed value, so send that.
    const trimmed = next.trim();
    if (trimmed !== (task.description ?? "")) {
      void editTask(task.id, { description: trimmed });
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
      data-testid={`task-card-${task.id}`}
      className="shrink-0 cursor-grab rounded-md border border-line bg-panel p-2 transition-colors hover:border-line-strong active:cursor-grabbing"
    >
      {editing !== null ? (
        <input
          autoFocus
          value={editing}
          aria-label="Task title"
          onChange={(event) => setEditing(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTitle();
            if (event.key === "Escape") setEditing(null);
          }}
          className="selectable w-full rounded-sm border border-accent bg-canvas px-1 py-0.5 text-[11px] text-ink focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onDoubleClick={() => setEditing(task.title)}
          onClick={(event) => {
            if (isKeyboardClick(event)) setEditing(task.title);
          }}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault();
              setEditing(task.title);
            }
          }}
          aria-label={`Rename task: ${task.title}`}
          title="Rename (Enter or F2). Double-click also works."
          className="block w-full text-left text-[11px] leading-snug text-ink"
        >
          {task.title}
        </button>
      )}

      {editingDesc !== null ? (
        <input
          autoFocus
          value={editingDesc}
          aria-label="Task description"
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
        <button
          type="button"
          onDoubleClick={() => setEditingDesc(task.description ?? "")}
          onClick={(event) => {
            if (isKeyboardClick(event)) setEditingDesc(task.description ?? "");
          }}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault();
              setEditingDesc(task.description ?? "");
            }
          }}
          aria-label={`Edit description: ${task.title}`}
          title="Edit description (Enter or F2). Double-click also works."
          className="mt-1 line-clamp-2 w-full text-left text-[10px] leading-snug text-ink-faint"
        >
          {task.description ?? "Add description…"}
        </button>
      )}

      {assigned !== undefined && (
        <p
          className="mt-1.5 flex items-center gap-1 text-[10px] text-ink-muted"
          aria-label={`${targetLabel({ kind: "session", session: assigned })}, ${sessionStatusPhrase(assigned.status)}`}
        >
          <StatusDot status={assigned.status} />
          <span className="min-w-0 truncate">
            {targetLabel({ kind: "session", session: assigned })}
          </span>
          <CardStepTally sessionId={assigned.id} />
          <span className="shrink-0 font-mono text-ink-faint">
            {sessionStatusPhrase(assigned.status)}
          </span>
        </p>
      )}

      {pending.map((request) => (
        <div key={request.requestId} className="mt-1.5 rounded-sm bg-elevated p-1.5">
          <p className="text-[10px] leading-snug text-ink-muted">{request.summary}</p>
          <div className="mt-1">
            <PermissionActions
              request={request}
              sessionId={assigned?.id}
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
        <QuietButton
          label="◀"
          title={column > 0 ? `Move to ${COLUMNS[column - 1]?.label}` : "Already leftmost"}
          disabled={column <= 0}
          onClick={() => moveBy(-1)}
        />
        <QuietButton
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

        <QuietButton label="Rename" onClick={() => setEditing(task.title)} />
        <QuietButton
          label={busy ? "Dispatching…" : choosing ? "Cancel" : "Dispatch"}
          title={blocked ? (blockReason ?? undefined) : undefined}
          disabled={busy || (blocked && !choosing)}
          onClick={() => setChoosing(!choosing)}
        />
        <QuietButton label="Delete" onClick={() => void removeTask(task.id)} />
      </div>

      {choosing && (
        <div className="mt-1 flex flex-col items-start gap-0.5 border-t border-line pt-1">
          {targets.length === 0 ? (
            <p className="text-[10px] leading-snug text-ink-faint">
              No agent is running and no pane is free.
            </p>
          ) : (
            targets.map((target) => (
              <QuietButton
                key={targetKey(target)}
                label={targetLabel(target)}
                title={blocked ? (blockReason ?? undefined) : undefined}
                disabled={blocked}
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
      data-testid={`task-column-${status}`}
      className={`flex min-h-0 flex-col gap-1.5 rounded-md border p-1.5 transition-colors ${
        over ? "border-accent bg-accent-soft" : "border-line bg-canvas"
      }`}
    >
      <div className="flex shrink-0 items-baseline gap-1.5 px-0.5">
        <h2 className="text-[11px] font-medium text-ink-muted">{label}</h2>
        <span className="font-mono text-[10px] text-ink-faint">{tasks.length}</span>
      </div>

      {status === "backlog" && <NewTaskForm key={projectId} projectId={projectId} />}

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
  const { blocked, blockReason, anyway, onDispatched } = useContext(DispatchGateContext);
  const dispatch = useTaskStore((state) => state.dispatch);
  const dispatchToNewSession = useTaskStore((state) => state.dispatchToNewSession);
  const [over, setOver] = useState<string | null>(null);

  if (targets.length === 0) return null;

  const drop = (target: DispatchTarget, taskId: string) => {
    if (blocked) return;
    const options = { anyway };
    onDispatched();
    if (target.kind === "session") void dispatch(taskId, target.session.id, options);
    else void dispatchToNewSession(taskId, project.id, paneOf(target), options);
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
              if (draggingId === null || blocked) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              setOver(null);
              if (draggingId === null || blocked) return;
              event.preventDefault();
              drop(target, draggingId);
            }}
            title={blocked ? (blockReason ?? undefined) : undefined}
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
          aria-pressed={chosen.includes(role.name)}
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

function InboxZeroBanner({
  reason,
  phrase,
  onPhrase,
}: {
  reason: string;
  phrase: string;
  onPhrase: (value: string) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
      <p role="status" className="min-w-0 flex-1 text-[10px] leading-snug text-ink-muted">
        {reason}
      </p>
      <input
        aria-label="Type dispatch anyway to hand out a card"
        value={phrase}
        onChange={(event) => onPhrase(event.target.value)}
        placeholder={DISPATCH_ANYWAY}
        className="selectable w-44 rounded-md border border-line bg-canvas px-2 py-0.5 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
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
  const tasks = useTasksForProject(project.id);
  const sessions = useSessionsForProject(project.id);
  const permissions = useUiStore((state) => state.permissions);
  const inboxZeroGate = useSettingsStore((state) => state.settings.inboxZeroGate);
  const [dragging, setDragging] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anywayPhrase, setAnywayPhrase] = useState("");

  const defaultDispatch = useSettingsStore((state) => state.settings.defaultDispatch);
  const targets = dispatchTargets(project, sessions, defaultDispatch);
  const capable = sessionsWithSteps(sessions);
  const selected =
    capable.find((session) => session.id === selectedId) ?? capable[0] ?? undefined;
  const waiting = needsYouWaiting(sessions, tasks, permissions, project.id);
  const anyway = typedDispatchAnyway(anywayPhrase);
  const blockReason = inboxZeroBlockReason(inboxZeroGate, waiting, false);
  const blocked = blockReason !== null && !anyway;
  const clearAnyway = () => setAnywayPhrase("");

  return (
    <div className="flex min-h-0 flex-1">
      <SessionStepsRail sessions={sessions} selected={selected} onSelect={setSelectedId} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {blockReason !== null && (
          <InboxZeroBanner reason={blockReason} phrase={anywayPhrase} onPhrase={setAnywayPhrase} />
        )}
        <DispatchGateContext.Provider
          value={{ blocked, blockReason, anyway, onDispatched: clearAnyway }}
        >
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
        </DispatchGateContext.Provider>
      </div>
    </div>
  );
}

export { TaskBoard };
