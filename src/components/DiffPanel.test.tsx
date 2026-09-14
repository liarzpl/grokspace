import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commentsPrompt, type DiffComment } from "../lib/diffPrompt";
import { project, session } from "../test/fixtures";
import type { DiffState } from "../types";

const projectDiff = vi.fn();
const fileDiff = vi.fn();
const talkToSession = vi.fn();

vi.mock("../lib/talkToSession", () => ({
  talkToSession: (...args: unknown[]) => talkToSession(...args),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { errorMessage: actual.errorMessage, api: { projectDiff, fileDiff } };
});

const { default: DiffPanel } = await import("./DiffPanel");
const { useDiffStore } = await import("../stores/diffStore");
const { useSessionStore } = await import("../stores/sessionStore");

const initialDiff = useDiffStore.getState();
const initialSessions = useSessionStore.getState();

const changed: DiffState = {
  state: "changed",
  branch: "grokspace/s1",
  files: [{ path: "src/lib.rs", change: "modified" }],
  overlaps: [],
};

const comment: DiffComment = {
  path: "src/lib.rs",
  hunkIndex: 0,
  text: "keep the comment",
  hunk: "@@ -1 +1 @@\n+x",
};

const agent = session({
  id: "s1",
  kind: "agent",
  status: "idle",
  title: "Coder",
  worktreePath: "/tmp/wt",
  paneId: null,
});

async function show(status: "idle" | "running") {
  const user = userEvent.setup();
  projectDiff.mockResolvedValue(changed);
  useSessionStore.setState({
    sessions: [{ ...agent, status }],
  });
  useDiffStore.setState({ comments: { s1: [comment] } });
  render(<DiffPanel project={project()} />);
  await user.click(await screen.findByRole("radio", { name: "Coder" }));
  const send = await screen.findByRole("button", { name: "Send to idle agent" });
  return { user, send };
}

describe("DiffPanel comment bundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    talkToSession.mockResolvedValue(undefined);
    useDiffStore.setState(initialDiff, true);
    useSessionStore.setState(initialSessions, true);
  });

  it("disables send when the session is not idle", async () => {
    const { send } = await show("running");
    expect(send).toBeDisabled();
    expect(talkToSession).not.toHaveBeenCalled();
  });

  it("sends every open comment and clears them after success", async () => {
    const { user, send } = await show("idle");
    expect(send).toBeEnabled();

    await user.click(send);

    await waitFor(() => {
      expect(talkToSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: "s1", status: "idle" }),
        commentsPrompt([comment]),
      );
    });
    expect(useDiffStore.getState().comments.s1).toBeUndefined();
  });

  it("keeps the comments when send fails", async () => {
    talkToSession.mockRejectedValue("that session is no longer running");
    const { user, send } = await show("idle");

    await user.click(send);

    await waitFor(() => {
      expect(useDiffStore.getState().error).toBe("that session is no longer running");
    });
    expect(useDiffStore.getState().comments.s1).toEqual([comment]);
  });
});
