import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { project } from "../test/fixtures";

vi.mock("../lib/terminals", () => import("../test/terminalsMock"));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: {
      listProjects: vi.fn(),
      listSessions: vi.fn(),
    },
  };
});

const { default: CommandPalette } = await import("./CommandPalette");
const { useProjectStore } = await import("../stores/projectStore");
const { useUiStore } = await import("../stores/uiStore");

const initialUi = useUiStore.getState();
const initialProjects = useProjectStore.getState();

function openPalette() {
  const acme = project();
  useProjectStore.setState({ projects: [acme], activeProjectId: acme.id });
  useUiStore.setState({ isPaletteOpen: true });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState(initialUi, true);
    useProjectStore.setState(initialProjects, true);
  });

  it("renders nothing while the store says it is closed", () => {
    render(<CommandPalette />);

    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("lists commands once opened", () => {
    openPalette();
    render(<CommandPalette />);

    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("What would you like to do?")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Show terminals/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Open settings/ })).toBeInTheDocument();
  });

  it("closes on Escape from the search field", async () => {
    const user = userEvent.setup();
    openPalette();
    render(<CommandPalette />);

    await user.keyboard("{Escape}");

    expect(useUiStore.getState().isPaletteOpen).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes when the backdrop is pressed", async () => {
    const user = userEvent.setup();
    openPalette();
    render(<CommandPalette />);

    // The dialog stops the mousedown; the dimmed layer behind it is what closes.
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    await user.pointer({ keys: "[MouseLeft>]", target: dialog.parentElement! });

    expect(useUiStore.getState().isPaletteOpen).toBe(false);
  });

  it("runs the highlighted row on Enter, and arrows move the highlight", async () => {
    const user = userEvent.setup();
    openPalette();
    render(<CommandPalette />);

    // Declaration order: terminals, then graph. One ArrowDown is enough.
    await user.keyboard("{ArrowDown}{Enter}");

    expect(useUiStore.getState().tab).toBe("graph");
    expect(useUiStore.getState().isPaletteOpen).toBe(false);
  });

  it("filters the list and runs the match", async () => {
    const user = userEvent.setup();
    openPalette();
    render(<CommandPalette />);

    await user.type(screen.getByPlaceholderText("What would you like to do?"), "settings");
    expect(screen.getByRole("option", { name: /Open settings/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Show terminals/ })).not.toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(useUiStore.getState().isSettingsOpen).toBe(true);
    expect(useUiStore.getState().isPaletteOpen).toBe(false);
  });

  it("runs a row on mouse down so focus-loss cannot close it first", async () => {
    const user = userEvent.setup();
    openPalette();
    render(<CommandPalette />);

    await user.pointer({
      keys: "[MouseLeft>]",
      target: screen.getByRole("option", { name: /Open settings/ }),
    });

    expect(useUiStore.getState().isSettingsOpen).toBe(true);
  });
});
