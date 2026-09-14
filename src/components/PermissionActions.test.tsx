import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  grantSessionLease,
  resetSessionLeases,
} from "../lib/permissionLease";
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
    resetSessionLeases();
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
    expect(screen.getByTestId("permission-actions")).toHaveAttribute("data-inbox-keys", "");
    expect(screen.getByRole("button", { name: "Allow" })).toHaveAttribute(
      "title",
      "Allow once (A)",
    );
    expect(screen.getByRole("button", { name: "Deny" })).toHaveAttribute("title", "Deny (D)");
    expect(screen.queryByTestId("permission-why")).not.toBeInTheDocument();
  });

  it("offers a session lease and answers the next match as allow_once", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    useSessionStore.setState({
      sessions: [session({ id: "s1", paneId: null, kind: "agent", status: "needs_input" })],
    });

    render(
      <PermissionActions request={request} sessionId="s1" onAnswer={onAnswer} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Also this session: Edit src/**" }),
    );
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(true);
    expect(onAnswer.mock.calls[0]?.[1]).toBeUndefined();

    const next: PermissionRequest = {
      ...request,
      requestId: 2,
      summary: "Edit src/lib/permissions.ts",
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Deny", kind: "reject_once" },
      ],
    };
    const auto = vi.fn();
    render(<PermissionActions request={next} sessionId="s1" onAnswer={auto} />);

    await waitFor(() => {
      expect(auto).toHaveBeenCalledTimes(1);
    });
    expect(auto).toHaveBeenCalledWith(true);
    expect(auto.mock.calls[0]?.[1]).toBeUndefined();
    expect(screen.getByTestId("permission-lease-auto")).toHaveTextContent(
      "Allowing Edit src/** this session",
    );
  });

  it("does not auto-answer when the agent only offered allow_always", () => {
    grantSessionLease("s1", { tool: "Edit", prefix: "src/" });
    useSessionStore.setState({
      sessions: [session({ id: "s1", paneId: null, kind: "agent", status: "needs_input" })],
    });
    const onAnswer = vi.fn();

    render(
      <PermissionActions
        request={{
          requestId: 3,
          summary: "Edit src/auth.ts",
          options: [
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" },
          ],
        }}
        sessionId="s1"
        onAnswer={onAnswer}
      />,
    );

    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.queryByTestId("permission-lease-auto")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Also this session: Edit src/**" }),
    ).not.toBeInTheDocument();
  });

  it("shows a Reviewer deny suggestion and does not auto-answer", () => {
    const onAnswer = vi.fn();
    useSessionStore.setState({
      sessions: [
        session({
          id: "s1",
          paneId: null,
          kind: "agent",
          role: "Reviewer",
          status: "needs_input",
        }),
      ],
    });

    render(<PermissionActions request={request} sessionId="s1" onAnswer={onAnswer} />);

    expect(screen.getByTestId("permission-role-deny")).toHaveTextContent(
      "Reviewer profile suggests Deny",
    );
    expect(
      screen.queryByRole("button", { name: "Also this session: Edit src/**" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
