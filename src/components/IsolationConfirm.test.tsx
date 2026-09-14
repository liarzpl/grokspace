import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/terminals", () => import("../test/terminalsMock"));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { errorMessage: actual.errorMessage, api: {} };
});

const { default: IsolationConfirm } = await import("./IsolationConfirm");
const { useSessionStore } = await import("../stores/sessionStore");

const initial = useSessionStore.getState();
const ISOLATION_ERR =
  "isolation did not happen (this folder is not a git repository); confirm to start on the project tree";

describe("IsolationConfirm", () => {
  beforeEach(() => {
    useSessionStore.getState().cancelUnisolatedStart();
    useSessionStore.setState(initial, true);
  });

  it("renders nothing while nobody is waiting", () => {
    render(<IsolationConfirm />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers Cancel and Start on the project tree", async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ isolationConfirm: { message: ISOLATION_ERR } });
    render(<IsolationConfirm />);

    expect(screen.getByRole("dialog", { name: "Start on the project tree?" })).toBeInTheDocument();
    expect(screen.getByText(ISOLATION_ERR)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start on the project tree" }));
    expect(useSessionStore.getState().isolationConfirm).toBeNull();
  });
});
