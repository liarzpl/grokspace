import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PermissionPolicy } from "../types";

const readPermissionPolicy = vi.fn();
const writePermissionPolicy = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: { readPermissionPolicy, writePermissionPolicy },
  };
});

const { default: SettingsPanel } = await import("./SettingsPanel");
const { useUiStore } = await import("../stores/uiStore");

const emptyPolicy = (): PermissionPolicy => ({
  path: "/home/me/.grokspace/permission-policy.json",
  projectFile: ".grokspace/permission-policy.json",
  rules: [],
});

const initialUi = useUiStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState(initialUi, true);
  useUiStore.setState({ isSettingsOpen: true });
  readPermissionPolicy.mockResolvedValue(emptyPolicy());
  writePermissionPolicy.mockImplementation(async (rules: PermissionPolicy["rules"]) => ({
    ...emptyPolicy(),
    rules,
  }));
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
