import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { session } from "../test/fixtures";
import type { SessionStep, SessionSteps as StepsSnapshot } from "../types";

vi.mock("../lib/terminals", () => import("../test/terminalsMock"));

const writeSession = vi.fn();
const promptSession = vi.fn();
const listSessionSteps = vi.fn();
const approveSessionSteps = vi.fn();
const reopenSessionSteps = vi.fn();
const skillStatus = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      writeSession,
      promptSession,
      listSessionSteps,
      approveSessionSteps,
      reopenSessionSteps,
      skillStatus,
    },
  };
});

const { default: SessionSteps } = await import("./SessionSteps");
const { approvalPrompt } = await import("../lib/steps");
const { useSessionStore } = await import("../stores/sessionStore");
const { useStepStore } = await import("../stores/stepStore");

function step(overrides: Partial<SessionStep> = {}): SessionStep {
  return {
    id: "a",
    sessionId: "s1",
    sortIndex: 0,
    title: "Read auth.ts",
    status: "pending",
    origin: "agent",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<StepsSnapshot> = {}): StepsSnapshot {
  return {
    sessionId: "s1",
    phase: "proposed",
    steps: [step()],
    ...overrides,
  };
}

const initialSessions = useSessionStore.getState();
const initialSteps = useStepStore.getState();

function seed(
  phase: StepsSnapshot["phase"],
  current = session(),
  steps: SessionStep[] = [step()],
) {
  useSessionStore.setState({ sessions: [current] });
  useStepStore.setState({
    bySession: {
      [current.id]: { sessionId: current.id, phase, steps, isLoading: false },
    },
  });
}

describe("SessionSteps Spec | Build", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState(initialSessions, true);
    useStepStore.setState(initialSteps, true);
    writeSession.mockResolvedValue(undefined);
    promptSession.mockResolvedValue(undefined);
    skillStatus.mockResolvedValue({ id: "steps", installed: true, current: true, path: "" });
    approveSessionSteps.mockImplementation(async (id: string) =>
      snapshot({ sessionId: id, phase: "approved" }),
    );
    reopenSessionSteps.mockImplementation(async (id: string) =>
      snapshot({ sessionId: id, phase: "proposed" }),
    );
  });

  it("marks Spec while the list is proposed", () => {
    seed("proposed");
    render(<SessionSteps session={session()} />);

    expect(screen.getByRole("radiogroup", { name: "Spec or Build" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Spec" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Build" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Build" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("marks Build after the list is approved", () => {
    seed("approved");
    render(<SessionSteps session={session()} />);

    expect(screen.getByRole("radio", { name: "Spec" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Build" })).toHaveAttribute("aria-checked", "true");
  });

  it("Build locks the list and sends the same approval prompt", async () => {
    const user = userEvent.setup();
    const grok = session();
    const steps = [step()];
    seed("proposed", grok, steps);
    approveSessionSteps.mockResolvedValue({ sessionId: grok.id, phase: "approved", steps });

    render(<SessionSteps session={grok} />);
    await user.click(screen.getByRole("radio", { name: "Build" }));

    await waitFor(() =>
      expect(writeSession).toHaveBeenCalledWith(grok.id, `${approvalPrompt(steps)}\r`),
    );
    expect(approveSessionSteps).toHaveBeenCalledWith(grok.id);
    expect(promptSession).not.toHaveBeenCalled();
  });

  it("leaves Build disabled while an ACP agent is still working", () => {
    const agent = session({ kind: "agent", paneId: null, status: "running" });
    seed("proposed", agent);
    render(<SessionSteps session={agent} />);

    expect(screen.getByRole("radio", { name: "Build" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Spec" })).toBeEnabled();
  });

  it("Spec on an approved list reopens to proposed", async () => {
    const user = userEvent.setup();
    seed("approved");
    render(<SessionSteps session={session()} />);

    await user.click(screen.getByRole("radio", { name: "Spec" }));

    await waitFor(() => expect(reopenSessionSteps).toHaveBeenCalledWith("s1"));
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("hides the chip when there is no list yet", () => {
    seed("none", session(), []);
    render(<SessionSteps session={session()} />);

    expect(screen.queryByRole("radiogroup", { name: "Spec or Build" })).not.toBeInTheDocument();
    expect(screen.getByText("The agent has not proposed steps yet.")).toBeInTheDocument();
  });
});
