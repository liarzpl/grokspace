import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PermissionPolicy, ProjectHooksStatus, WorktreeGcEntry } from "../types";
import { project } from "../test/fixtures";

const readPermissionPolicy = vi.fn();
const writePermissionPolicy = vi.fn();
const previewWorktreeGc = vi.fn();
const gcOrphanWorktrees = vi.fn();
const listPermissionLedger = vi.fn();
const projectTrust = vi.fn();
const setProjectTrust = vi.fn();
const projectHooksStatus = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      readPermissionPolicy,
      writePermissionPolicy,
      previewWorktreeGc,
      gcOrphanWorktrees,
      listPermissionLedger,
      projectTrust,
      setProjectTrust,
      projectHooksStatus,
    },
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
  listPermissionLedger.mockResolvedValue([]);
  projectTrust.mockResolvedValue("unknown");
  setProjectTrust.mockResolvedValue("folder");
  projectHooksStatus.mockResolvedValue(hooksStatus());
});

const hooksStatus = (overrides: Partial<ProjectHooksStatus> = {}): ProjectHooksStatus => ({
  hostTrust: "unknown",
  hooksAllowed: false,
  hookFiles: [".grok/hooks/lint.json"],
  grokTrustFile: "/home/me/.grok/trusted_folders.toml",
  grokListsFolder: false,
  ...overrides,
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

describe("SettingsPanel project hooks", () => {
  it("asks for a project when none is open", async () => {
    render(<SettingsPanel />);
    expect(
      await screen.findByText("Open a project to see whether its hooks are trusted."),
    ).toBeInTheDocument();
    expect(projectHooksStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Trust this folder" })).not.toBeInTheDocument();
  });

  it("shows untrusted hooks and records Trust this folder without Allow forever", async () => {
    const user = userEvent.setup();
    useProjectStore.setState({
      projects: [project()],
      activeProjectId: "p1",
      folderTrust: { p1: "unknown" },
    });
    projectHooksStatus.mockResolvedValue(hooksStatus());

    render(<SettingsPanel />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Not decided — setup and project hooks stay off",
    );
    expect(screen.getByRole("list", { name: "Project hook files" })).toHaveTextContent(
      ".grok/hooks/lint.json",
    );
    expect(screen.getByText(/does not list this folder/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /allow forever/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Trust this folder" }));
    await waitFor(() => {
      expect(setProjectTrust).toHaveBeenCalledWith("p1", "folder");
    });
  });

  it("hides trust buttons once the folder is trusted", async () => {
    projectTrust.mockResolvedValue("folder");
    useProjectStore.setState({
      projects: [project()],
      activeProjectId: "p1",
      folderTrust: { p1: "folder" },
    });
    projectHooksStatus.mockResolvedValue(
      hooksStatus({ hostTrust: "folder", hooksAllowed: true, grokListsFolder: true }),
    );

    render(<SettingsPanel />);
    expect(await screen.findByRole("status")).toHaveTextContent("This folder is trusted");
    expect(screen.getByText(/also lists this folder/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trust this folder" })).not.toBeInTheDocument();
  });
});

describe("SettingsPanel permission ledger", () => {
  it("replays last answers and stays quiet with no project", async () => {
    useProjectStore.setState({
      projects: [project()],
      activeProjectId: "p1",
    });
    listPermissionLedger.mockResolvedValue([
      {
        time: 1,
        sessionId: "s",
        requestId: 9,
        summary: "Edit a.ts",
        chip: "allow_once",
        optionId: null,
      },
      {
        time: 2,
        sessionId: "s",
        requestId: 10,
        summary: "Bash rm",
        chip: "deny",
        optionId: null,
      },
    ]);
    const { unmount } = render(<SettingsPanel />);
    const list = await screen.findByRole("list", { name: "Permission ledger" });
    expect(list).toHaveTextContent("Bash rm");
    expect(listPermissionLedger).toHaveBeenCalledWith("p1", 20);
    unmount();
    useProjectStore.setState({ activeProjectId: null });
    listPermissionLedger.mockClear();
    render(<SettingsPanel />);
    expect(
      await screen.findByText("Open a project to replay its permission ledger."),
    ).toBeInTheDocument();
    expect(listPermissionLedger).not.toHaveBeenCalled();
  });
});
