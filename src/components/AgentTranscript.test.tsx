import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_MEMORY_CHARS } from "../lib/limits";
import { session } from "../test/fixtures";
import type { AgentUpdate, MemoryEntry } from "../types";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { errorMessage: actual.errorMessage, api: {} };
});

const { default: AgentTranscript } = await import("./AgentTranscript");
const { useMemoryStore } = await import("../stores/memoryStore");
const { useSessionStore } = await import("../stores/sessionStore");

const initialMemory = useMemoryStore.getState();
const initialSessions = useSessionStore.getState();
const agent = session({ kind: "agent", status: "idle", title: "Coder" });

function show(lines: AgentUpdate[], entries: MemoryEntry[] = []) {
  const createEntry = vi.fn().mockResolvedValue(true);
  useMemoryStore.setState({ createEntry, projectId: "p1", entries });
  useSessionStore.setState({ transcript: { s1: lines } });
  render(<AgentTranscript session={agent} />);
  return createEntry;
}

describe("AgentTranscript memory chip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMemoryStore.setState(initialMemory, true);
    useSessionStore.setState(initialSessions, true);
  });

  it("calls createEntry with projectId and the named key", async () => {
    const user = userEvent.setup();
    const createEntry = show([
      { kind: "message", text: "SQLite stays in-process.\nMemory key: `database`" },
    ]);

    await user.click(screen.getByRole("button", { name: "Add to Memory" }));
    expect(screen.getByLabelText("Memory key")).toHaveValue("database");
    expect(screen.getByRole("radio", { name: "note" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "decision" }));
    await user.click(screen.getByRole("button", { name: "Remember" }));

    expect(createEntry).toHaveBeenCalledWith("p1", {
      key: "database",
      content: "SQLite stays in-process.",
      type: "decision",
    });
  });

  it("refuses a write that would pass the cap", async () => {
    const user = userEvent.setup();
    const createEntry = show(
      [{ kind: "message", text: "A longer note.\nMemory key: `overflow`" }],
      [
        {
          projectId: "p1",
          key: "big",
          content: "x".repeat(MAX_MEMORY_CHARS - 2),
          type: "note",
          updatedAt: 1000,
        },
      ],
    );

    await user.click(screen.getByRole("button", { name: "Add to Memory" }));
    expect(screen.getByRole("button", { name: "Remember" })).toBeDisabled();
    expect(createEntry).not.toHaveBeenCalled();
  });

  it("offers a manual chip on the last line", async () => {
    const user = userEvent.setup();
    const createEntry = show([
      { kind: "message", text: "earlier, no key" },
      { kind: "message", text: "worth keeping" },
    ]);

    expect(screen.getAllByRole("button", { name: "Add to Memory" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Add to Memory" }));
    await user.type(screen.getByLabelText("Memory key"), "convention");
    await user.click(screen.getByRole("button", { name: "Remember" }));

    expect(createEntry).toHaveBeenCalledWith("p1", {
      key: "convention",
      content: "worth keeping",
      type: "note",
    });
  });

  it("does not write memory.md from the renderer", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "AgentTranscript.tsx"), "utf8");
    expect(source).toContain("createEntry");
    expect(source).not.toMatch(/writeTextFile|writeFile|put_memory|memory\.md/);
  });
});
