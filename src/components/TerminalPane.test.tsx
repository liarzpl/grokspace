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

const initialSessions = useSessionStore.getState();

describe("TerminalPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState(initialSessions, true);
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
