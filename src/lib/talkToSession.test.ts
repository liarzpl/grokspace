import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../types";

const writeSession = vi.fn();
const promptSession = vi.fn();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    errorMessage: actual.errorMessage,
    api: { writeSession, promptSession },
  };
});

const { talkToSession, transcriptExcerpt, handoffPrompt, BATON_EXCERPT_BYTES } =
  await import("./talkToSession");

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    paneId: "0",
    processId: 1,
    status: "running",
    title: "Grok",
    role: null,
    worktreePath: null,
    kind: "grok",
    exitCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  writeSession.mockResolvedValue(undefined);
  promptSession.mockResolvedValue(undefined);
});

describe("talkToSession", () => {
  it("prompts an ACP agent rather than writing a pty it does not have", async () => {
    await talkToSession(session({ kind: "agent", paneId: null, status: "idle" }), "hello");

    expect(promptSession).toHaveBeenCalledWith("s1", "hello");
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("types into a Grok pane and submits with a trailing CR", async () => {
    await talkToSession(session(), "hello");

    expect(writeSession).toHaveBeenCalledWith("s1", "hello\r");
    expect(promptSession).not.toHaveBeenCalled();
  });

  it("types into a shell the same way, so a forgotten CR is not a third path", async () => {
    await talkToSession(session({ kind: "shell" }), "ls");

    expect(writeSession).toHaveBeenCalledWith("s1", "ls\r");
    expect(promptSession).not.toHaveBeenCalled();
  });
});

describe("transcriptExcerpt", () => {
  it("flattens to one line and keeps a short transcript", () => {
    expect(
      transcriptExcerpt([
        { text: "hello\nthere" },
        { text: "  world" },
      ]),
    ).toBe("hello there world");
  });

  it("caps at 2 KiB and does not paste the full transcript", () => {
    const unique = "HEAD-" + "x".repeat(BATON_EXCERPT_BYTES) + "-TAIL";
    const excerpt = transcriptExcerpt([{ text: unique }]);

    expect(new TextEncoder().encode(excerpt).length).toBeLessThanOrEqual(BATON_EXCERPT_BYTES);
    expect(excerpt).not.toBe(unique);
    expect(excerpt).not.toContain("HEAD-");
    expect(excerpt.endsWith("-TAIL")).toBe(true);
  });
});

describe("handoffPrompt", () => {
  const graph = "/p/.grokspace/graphs/old.json";

  it("names memory, the previous graph as read-only, steps, and a capped excerpt", () => {
    const prompt = handoffPrompt({
      graphPath: graph,
      stepTitles: ["Ship the gate"],
      excerpt: "recent-tail",
    });

    expect(prompt).not.toContain("\n");
    expect(prompt).toContain("new conversation");
    expect(prompt).not.toContain("--resume");
    expect(prompt).toContain("$GROKSPACE_MEMORY_FILE");
    expect(prompt).toContain(graph);
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("$GROKSPACE_GRAPH_FILE");
    expect(prompt).toContain("1. Ship the gate");
    expect(prompt).toContain("recent-tail");
  });

  it("includes proposed step titles and omits an empty excerpt", () => {
    const prompt = handoffPrompt({
      graphPath: graph,
      stepTitles: ["Read it"],
      excerpt: "",
    });

    expect(prompt).toContain("1. Read it");
    expect(prompt).not.toContain("Excerpt:");
  });
});
