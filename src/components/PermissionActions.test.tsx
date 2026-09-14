import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { session } from "../test/fixtures";
import type { PermissionRequest, SessionStep } from "../types";
import { PermissionActions } from "./PermissionActions";
import { useDiffStore } from "../stores/diffStore";
import { useSessionStore } from "../stores/sessionStore";
import { useStepStore } from "../stores/stepStore";

const request: PermissionRequest = {
  requestId: 1,
  summary: "Edit src/auth.ts",
  options: [
    { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    { optionId: "reject-once", name: "Deny", kind: "reject_once" },
  ],
};

function step(overrides: Partial<SessionStep> = {}): SessionStep {
  return {
    id: "a",
    sessionId: "s1",
    sortIndex: 0,
    title: "Write the login handler",
    status: "doing",
    origin: "agent",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const initialSessions = useSessionStore.getState();
const initialSteps = useStepStore.getState();
const initialDiff = useDiffStore.getState();

describe("PermissionActions", () => {
  beforeEach(() => {
    useSessionStore.setState(initialSessions, true);
    useStepStore.setState(initialSteps, true);
    useDiffStore.setState(initialDiff, true);
  });

  it("lists session title, doing step, worktree, and loaded overlap paths", () => {
    useSessionStore.setState({
      sessions: [
        session({
          id: "s1",
          paneId: null,
          kind: "agent",
          title: "Coder",
          worktreePath: "/Users/dev/acme/.grokspace/worktrees/s1",
        }),
      ],
    });
    useStepStore.setState({
      bySession: {
        s1: {
          sessionId: "s1",
          phase: "approved",
          steps: [step()],
          isLoading: false,
        },
      },
    });
    useDiffStore.setState({
      scope: "s1",
      isLoading: false,
      diff: {
        state: "changed",
        branch: "grokspace/s1",
        files: [],
        overlaps: [{ path: "src/auth.ts", hotspot: false, peers: [] }],
      },
    });

    render(
      <PermissionActions request={request} sessionId="s1" onAnswer={() => {}} />,
    );

    expect(
      screen.getByText(
        "Coder · Write the login handler · ~/acme/.grokspace/worktrees/s1 · src/auth.ts",
      ),
    ).toBeInTheDocument();
  });

  it("omits missing pieces and ignores a diff loaded for another session", () => {
    useSessionStore.setState({
      sessions: [session({ id: "s1", paneId: null, kind: "agent", title: null })],
    });
    useStepStore.setState({
      bySession: {
        s1: {
          sessionId: "s1",
          phase: "none",
          steps: [step({ status: "pending" })],
          isLoading: false,
        },
      },
    });
    useDiffStore.setState({
      scope: "s2",
      isLoading: false,
      diff: {
        state: "changed",
        branch: "main",
        files: [],
        overlaps: [{ path: "src/auth.ts", hotspot: false, peers: [] }],
      },
    });

    const { rerender } = render(
      <PermissionActions request={request} sessionId="s1" onAnswer={() => {}} />,
    );

    expect(screen.queryByTestId("permission-why")).not.toBeInTheDocument();
    expect(screen.queryByText(/Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/src\/auth.ts/)).not.toBeInTheDocument();

    rerender(<PermissionActions request={request} onAnswer={() => {}} />);
    expect(screen.queryByTestId("permission-why")).not.toBeInTheDocument();
  });

  it("still answers Allow without requiring facts", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();

    render(<PermissionActions request={request} onAnswer={onAnswer} />);

    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAnswer).toHaveBeenCalledWith(true, undefined);
    expect(screen.queryByTestId("permission-why")).not.toBeInTheDocument();
  });
});
