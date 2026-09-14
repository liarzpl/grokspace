import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { project, task } from "../test/fixtures";

vi.mock("../lib/terminals", () => import("../test/terminalsMock"));

vi.mock("./SessionSteps", () => ({
  default: () => null,
  SessionStepsRail: () => null,
}));

vi.mock("./PermissionActions", () => ({
  PermissionActions: () => null,
}));

const updateTask = vi.fn();
const listTasks = vi.fn();
const createSession = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      updateTask,
      listTasks,
      listSessions: vi.fn(),
      createSession,
      promptSession: vi.fn(),
    },
  };
});

const { default: TaskBoard } = await import("./TaskBoard");
const { default: IsolationConfirm } = await import("./IsolationConfirm");
const { useSessionStore } = await import("../stores/sessionStore");
const { useTaskStore } = await import("../stores/taskStore");

const ISOLATION_ERR =
  "isolation did not happen (this folder is not a git repository); confirm to start on the project tree";

const initialTasks = useTaskStore.getState();
const initialSessions = useSessionStore.getState();

/** jsdom will not invent a DataTransfer; the card writes the id even though drop reads React state. */
function transfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "all",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    setData(type: string, value: string) {
      store.set(type, value);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
    clearData() {
      store.clear();
    },
    setDragImage() {},
  } as DataTransfer;
}

describe("TaskBoard drag and drop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.getState().cancelUnisolatedStart();
    useTaskStore.setState(initialTasks, true);
    useSessionStore.setState(initialSessions, true);
    updateTask.mockImplementation(async (id: string, changes: { status?: string }) => {
      const current = useTaskStore.getState().tasks.find((row) => row.id === id);
      if (current === undefined) throw new Error(`missing task ${id}`);
      return { ...current, ...changes, updatedAt: 2000 };
    });
  });

  it("moves a card into another column from React drag state, not getData", async () => {
    useTaskStore.setState({ tasks: [task()] });
    render(<TaskBoard project={project()} />);

    const card = screen.getByTestId("task-card-t1");
    const review = screen.getByTestId("task-column-review");
    const payload = transfer();

    fireEvent.dragStart(card, { dataTransfer: payload });
    fireEvent.dragEnter(review, { dataTransfer: payload });
    fireEvent.dragOver(review, { dataTransfer: payload });
    fireEvent.drop(review, { dataTransfer: payload });
    fireEvent.dragEnd(card);

    await waitFor(() => {
      expect(updateTask).toHaveBeenCalledWith("t1", { status: "review" });
    });
    expect(useTaskStore.getState().tasks[0]?.status).toBe("review");
  });

  it("does not write when the card is dropped on the column it already sits in", async () => {
    useTaskStore.setState({ tasks: [task()] });
    render(<TaskBoard project={project()} />);

    const card = screen.getByTestId("task-card-t1");
    const backlog = screen.getByTestId("task-column-backlog");
    const payload = transfer();

    fireEvent.dragStart(card, { dataTransfer: payload });
    fireEvent.drop(backlog, { dataTransfer: payload });

    expect(updateTask).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[0]?.status).toBe("backlog");
  });

  it("ignores a drop that never started as a card drag", () => {
    useTaskStore.setState({ tasks: [task()] });
    render(<TaskBoard project={project()} />);

    fireEvent.drop(screen.getByTestId("task-column-done"), { dataTransfer: transfer() });

    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe("TaskBoard swarm isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.getState().cancelUnisolatedStart();
    useTaskStore.setState(initialTasks, true);
    useSessionStore.setState(initialSessions, true);
  });

  it("opens a confirm dialog instead of a raw isolation banner", async () => {
    createSession.mockRejectedValue(ISOLATION_ERR);
    render(
      <>
        <TaskBoard project={project()} />
        <IsolationConfirm />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch a swarm" }));
    fireEvent.click(screen.getByRole("button", { name: /Start \d/ }));

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Start on the project tree?" })).toBeInTheDocument(),
    );
    expect(useSessionStore.getState().error).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("allowUnisolated");
  });
});
