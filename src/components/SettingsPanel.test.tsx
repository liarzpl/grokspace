import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PermissionPolicy, WorktreeGcEntry } from "../types";
import { project } from "../test/fixtures";

const readPermissionPolicy = vi.fn();
const writePermissionPolicy = vi.fn();
const previewWorktreeGc = vi.fn();
const gcOrphanWorktrees = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: { readPermissionPolicy, writePermissionPolicy, previewWorktreeGc, gcOrphanWorktrees },
  };
});

const { default: SettingsPanel } = await import("./SettingsPanel");
const { useUiStore } = await import("../stores/uiStore");
const { useProjectStore } = await import("../stores/projectStore");

const emptyPolicy = (): PermissionPolicy => ({
  path: "/home/me/.grokspace/permission-policy.json",
  projectFile: ".grokspace/permission-policy.json",
  rules: [],
});

const initialUi = useUiStore.getState();
const initialProject = useProjectStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState(initialUi, true);
  useUiStore.setState({ isSettingsOpen: true });
  useProjectStore.setState(initialProject, true);
  readPermissionPolicy.mockResolvedValue(emptyPolicy());
  writePermissionPolicy.mockImplementation(async (rules: PermissionPolicy["rules"]) => ({
    ...emptyPolicy(),
    rules,
  }));
  previewWorktreeGc.mockResolvedValue([]);
  gcOrphanWorktrees.mockResolvedValue([]);
});

describe("SettingsPanel permission policy", () => {
  it("adds a deny glob and surfaces a refused star allow-similar", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await screen.findByRole("combobox", { name: "Policy action" });
    await user.type(screen.getByRole("textbox", { name: "Policy glob" }), "*git push*");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(writePermissionPolicy).toHaveBeenCalledWith([
        { action: "deny", pattern: "*git push*" },
      ]);
    });

    writePermissionPolicy.mockRejectedValue(
      "allow-once-similar cannot be a pattern that matches everything",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Policy action" }), [
      "allow-once-similar",
    ]);
    await user.clear(screen.getByRole("textbox", { name: "Policy glob" }));
    await user.type(screen.getByRole("textbox", { name: "Policy glob" }), "*");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("allow-once-similar");
  });
});

const orphan = (overrides: Partial<WorktreeGcEntry> = {}): WorktreeGcEntry => ({
  path: "/tmp/acme/.grokspace/worktrees/orphan",
  sessionId: "orphan",
  sizeBytes: 4096,
  dirty: false,
  removable: true,
  ...overrides,
});

describe("SettingsPanel worktree GC", () => {
  it("lists orphans with sizes and removes only clean trees after confirm", async () => {
    const user = userEvent.setup();
    useProjectStore.setState({
      projects: [project()],
      activeProjectId: "p1",
    });
    previewWorktreeGc.mockResolvedValue([
      orphan(),
      orphan({
        path: "/tmp/acme/.grokspace/worktrees/stale",
        sessionId: "stale",
        sizeBytes: 8192,
        dirty: true,
        removable: false,
        skipReason: "this agent still has uncommitted work",
      }),
    ]);
    gcOrphanWorktrees.mockResolvedValue([
      orphan({
        path: "/tmp/acme/.grokspace/worktrees/stale",
        sessionId: "stale",
        sizeBytes: 8192,
        dirty: true,
        removable: false,
        skipReason: "this agent still has uncommitted work",
      }),
    ]);

    render(<SettingsPanel />);
    await user.click(screen.getByRole("button", { name: "Scan leftovers" }));
    expect(previewWorktreeGc).toHaveBeenCalledWith("p1");
    expect(await screen.findByText("orphan")).toBeInTheDocument();
    expect(screen.getByText("4 KiB")).toBeInTheDocument();
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.getAllByText("dirty")).toHaveLength(1);
    expect(screen.queryByText("live")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove 1 clean" }));
    await waitFor(() => {
      expect(gcOrphanWorktrees).toHaveBeenCalledWith("p1");
    });
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.queryByText("orphan")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove 0 clean" })).toBeDisabled();
  });
});
