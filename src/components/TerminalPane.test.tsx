import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { session } from "../test/fixtures";
import {
  attachTerminal,
  detachTerminal,
  fitTerminal,
  mountTerminal,
} from "../test/terminalsMock";

vi.mock("../lib/terminals", () => import("../test/terminalsMock"));

vi.mock("./GraphVisualizer", () => ({
  default: () => <div data-testid="graph-visualizer" />,
}));

vi.mock("./SessionSteps", () => ({
  default: () => null,
  SessionStepsRail: () => null,
}));

const resizeSession = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: { resizeSession },
  };
});

const { default: TerminalPane } = await import("./TerminalPane");
const { useSessionStore } = await import("../stores/sessionStore");
const { useStepStore } = await import("../stores/stepStore");
const { useUiStore } = await import("../stores/uiStore");

const initialSessions = useSessionStore.getState();
const initialSteps = useStepStore.getState();
const initialUi = useUiStore.getState();

describe("TerminalPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState(initialSessions, true);
    useStepStore.setState(initialSteps, true);
    useUiStore.setState(initialUi, true);
    attachTerminal.mockResolvedValue(undefined);
    fitTerminal.mockReturnValue(null);
  });

  it("offers Start Grok and Shell in an empty pane", () => {
    render(<TerminalPane paneId="0" projectId="p1" />);

    expect(screen.getByText("Empty pane")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Grok" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Shell" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-surface")).not.toBeInTheDocument();
  });

  it("asks the store to start a grok session at the fallback size", async () => {
    const user = userEvent.setup();
    const startSession = vi.fn().mockResolvedValue(null);
    useSessionStore.setState({ startSession });

    render(<TerminalPane paneId="2" projectId="p1" />);
    await user.click(screen.getByRole("button", { name: "Start Grok" }));

    expect(startSession).toHaveBeenCalledWith({
      projectId: "p1",
      paneId: "2",
      kind: "grok",
      cols: 80,
      rows: 24,
    });
  });

  it("mounts and attaches the registry host, then detaches on unmount", async () => {
    const { unmount } = render(
      <TerminalPane paneId="0" projectId="p1" session={session()} />,
    );

    expect(screen.getByTestId("terminal-surface")).toBeInTheDocument();
    expect(screen.getByText("Grok")).toBeInTheDocument();

    await waitFor(() => {
      expect(mountTerminal).toHaveBeenCalledWith("s1", expect.any(HTMLElement));
    });
    expect(attachTerminal).toHaveBeenCalledWith("s1");
    expect(fitTerminal).toHaveBeenCalledWith("s1");
    expect(resizeSession).not.toHaveBeenCalled();

    unmount();
    expect(detachTerminal).toHaveBeenCalledWith("s1");
  });

  it("resizes the pty when the registry already has a measured size", async () => {
    fitTerminal.mockReturnValue({ cols: 120, rows: 40 });

    render(<TerminalPane paneId="0" projectId="p1" session={session()} />);

    await waitFor(() => {
      expect(resizeSession).toHaveBeenCalledWith("s1", 120, 40);
    });
  });
});

describe("TerminalPane permission mode chip", () => {
  it("shows plan | ask | acceptEdits on grok chrome, not yolo", () => {
    useSessionStore.setState({ sessions: [session()] });
    render(<TerminalPane paneId="0" projectId="p1" session={session()} />);

    expect(screen.getByRole("radiogroup", { name: "Permission mode" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "plan" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "ask" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "acceptEdits" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "yolo" })).not.toBeInTheDocument();
    expect(screen.queryByText("bypassPermissions")).not.toBeInTheDocument();
  });

  it("hides the chip on a shell pane", () => {
    const shell = session({ kind: "shell", title: "Shell" });
    useSessionStore.setState({ sessions: [shell] });
    render(<TerminalPane paneId="0" projectId="p1" session={shell} />);

    expect(screen.queryByRole("radiogroup", { name: "Permission mode" })).not.toBeInTheDocument();
  });

  it("marks plan when the steps list is Spec", () => {
    useSessionStore.setState({ sessions: [session()] });
    useStepStore.setState({
      bySession: { s1: { sessionId: "s1", phase: "proposed", steps: [], isLoading: false } },
    });
    render(<TerminalPane paneId="0" projectId="p1" session={session()} />);

    expect(screen.getByRole("radio", { name: "plan" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "ask" })).toHaveAttribute("aria-checked", "false");
  });

  it("records acceptEdits without sending a grok permission-mode", async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ sessions: [session()] });
    render(<TerminalPane paneId="0" projectId="p1" session={session()} />);

    await user.click(screen.getByRole("radio", { name: "acceptEdits" }));

    expect(useSessionStore.getState().permissionModes["s1"]).toBe("acceptEdits");
    expect(screen.getByRole("radio", { name: "acceptEdits" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
