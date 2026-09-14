import { beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_GRAPH } from "../lib/graphFixture";
import type { GraphSnapshot } from "../types";

const readSessionGraph = vi.fn();
const listSessionGraphs = vi.fn();
const watchProjectGraphs = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    errorMessage: actual.errorMessage,
    api: { readSessionGraph, listSessionGraphs, watchProjectGraphs },
  };
});

const { graphFor, stabilizeGraph, useGraphStore } = await import("./graphStore");

function snapshot(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    sessionId: "s1",
    path: "/p/.grokspace/graphs/s1.json",
    exists: true,
    json: JSON.stringify(SAMPLE_GRAPH),
    tooLarge: false,
    updatedAt: 1000,
    ...overrides,
  };
}

const initialState = useGraphStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  useGraphStore.setState(initialState, true);
});

const entry = (sessionId: string) => graphFor(useGraphStore.getState().bySession, sessionId);

describe("load", () => {
  it("parses a session's file into a drawable graph", async () => {
    readSessionGraph.mockResolvedValue(snapshot());

    await useGraphStore.getState().load("s1");

    expect(readSessionGraph).toHaveBeenCalledWith("s1");
    expect(entry("s1").graph?.name).toBe("Idea Generation");
    expect(entry("s1").path).toBe("/p/.grokspace/graphs/s1.json");
    expect(entry("s1").updatedAt).toBe(1000);
    expect(entry("s1").isLoading).toBe(false);
    expect(entry("s1").error).toBeNull();
  });

  it("keeps each session's graph to itself", async () => {
    readSessionGraph.mockImplementation((id: string) =>
      Promise.resolve(
        id === "s1"
          ? snapshot()
          : snapshot({
              sessionId: "s2",
              path: "/p/.grokspace/graphs/s2.json",
              json: JSON.stringify({ name: "Other run", nodes: [{ id: "a" }] }),
            }),
      ),
    );

    await useGraphStore.getState().load("s1");
    await useGraphStore.getState().load("s2");

    expect(entry("s1").graph?.name).toBe("Idea Generation");
    expect(entry("s2").graph?.name).toBe("Other run");
  });

  it("reports a session with no graph yet without calling it an error", async () => {
    readSessionGraph.mockResolvedValue(
      snapshot({ exists: false, json: null, updatedAt: null }),
    );

    await useGraphStore.getState().load("s1");

    expect(entry("s1").graph).toBeNull();
    expect(entry("s1").error).toBeNull();
    // The empty state names the file the session was told to write.
    expect(entry("s1").path).toBe("/p/.grokspace/graphs/s1.json");
  });

  it("surfaces a backend failure as the entry's error", async () => {
    readSessionGraph.mockRejectedValue("no session found with id s1");

    await useGraphStore.getState().load("s1");

    expect(entry("s1").error).toBe("no session found with id s1");
    expect(entry("s1").isLoading).toBe(false);
  });

  it("keeps the graph it already had while a re-read is in flight", async () => {
    readSessionGraph.mockResolvedValue(snapshot());
    await useGraphStore.getState().load("s1");

    let release: (value: GraphSnapshot) => void = () => {};
    readSessionGraph.mockReturnValue(
      new Promise<GraphSnapshot>((resolve) => {
        release = resolve;
      }),
    );
    const inFlight = useGraphStore.getState().load("s1");

    expect(entry("s1").graph?.name).toBe("Idea Generation");
    expect(entry("s1").isLoading).toBe(false);

    release(snapshot({ json: JSON.stringify({ name: "Replanned", nodes: [{ id: "a" }] }) }));
    await inFlight;

    expect(entry("s1").graph?.name).toBe("Replanned");
  });

  it("does not replace a graph whose file mtime and size are unchanged", async () => {
    readSessionGraph.mockResolvedValue(snapshot());
    await useGraphStore.getState().load("s1");
    const first = entry("s1").graph;

    await useGraphStore.getState().load("s1");

    expect(entry("s1").graph).toBe(first);
    expect(readSessionGraph).toHaveBeenCalledTimes(2);
  });

  it("reuses unchanged nodes when only one status flips", async () => {
    readSessionGraph.mockResolvedValue(snapshot());
    await useGraphStore.getState().load("s1");
    const firstOrch = entry("s1").graph?.nodes.find((node) => node.id === "orch");

    const next = structuredClone(SAMPLE_GRAPH) as {
      nodes: Array<{ id: string; status: string }>;
    };
    const other = next.nodes.find((node) => node.id === "tool-search");
    if (other) other.status = "running";
    readSessionGraph.mockResolvedValue(snapshot({ json: JSON.stringify(next), updatedAt: 2000 }));

    await useGraphStore.getState().load("s1");

    expect(entry("s1").graph?.nodes.find((node) => node.id === "orch")).toBe(firstOrch);
    expect(entry("s1").graph?.nodes.find((node) => node.id === "tool-search")?.status).toBe(
      "running",
    );
  });

  it("keeps the last drawable graph when a live rewrite is huge", async () => {
    readSessionGraph.mockResolvedValue(snapshot());
    await useGraphStore.getState().load("s1");
    const first = entry("s1").graph;

    readSessionGraph.mockResolvedValue(
      snapshot({
        json: `{"name":"huge","nodes":[{"id":"a"}]}`.padEnd(512 * 1024 + 8, " "),
        updatedAt: 3000,
      }),
    );

    await useGraphStore.getState().load("s1");

    expect(entry("s1").graph).toBe(first);
    expect(entry("s1").updatedAt).toBe(3000);
  });
});

describe("stabilizeGraph", () => {
  it("returns the previous document when nothing material changed", async () => {
    readSessionGraph.mockResolvedValue(snapshot());
    await useGraphStore.getState().load("s1");
    const graph = entry("s1").graph;
    expect(graph).not.toBeNull();
    if (graph === null) return;
    expect(stabilizeGraph(graph, structuredClone(graph))).toBe(graph);
  });
});

describe("a half-written file", () => {
  it("is read again before the parse failure is believed", async () => {
    // A writer that has not finished leaves truncated JSON behind; showing an
    // error for it would make every update flash red.
    readSessionGraph
      .mockResolvedValueOnce(snapshot({ json: '{"nodes": [{"id": "a"' }))
      .mockResolvedValueOnce(snapshot());

    await useGraphStore.getState().load("s1");

    expect(readSessionGraph).toHaveBeenCalledTimes(2);
    expect(entry("s1").graph?.name).toBe("Idea Generation");
    expect(entry("s1").error).toBeNull();
  });

  it("is reported once the retry fails too", async () => {
    readSessionGraph.mockResolvedValue(snapshot({ json: "not json at all" }));

    await useGraphStore.getState().load("s1");

    expect(readSessionGraph).toHaveBeenCalledTimes(2);
    expect(entry("s1").graph).toBeNull();
    expect(entry("s1").error).toContain("JSON");
  });
});

describe("a file that is valid JSON but not a graph", () => {
  it("is reported the first time it is read", async () => {
    readSessionGraph.mockResolvedValue(snapshot({ json: '{"name": "no nodes here"}' }));

    await useGraphStore.getState().load("s1");

    expect(entry("s1").error).toContain("nodes");
    // Nothing is half-written here, so a second read would say the same thing.
    // Waiting for one would put that cost on every update of a stably bad file.
    expect(readSessionGraph).toHaveBeenCalledTimes(1);
  });
});

describe("a file the backend refused for its size", () => {
  it("is reported rather than shown as a graph that has not arrived", async () => {
    readSessionGraph.mockResolvedValue(snapshot({ json: null, tooLarge: true }));

    await useGraphStore.getState().load("s1");

    // The empty state would name this file and wait for it, which it is not going
    // to get: the file is already there.
    expect(entry("s1").error).toContain("too large");
    expect(entry("s1").graph).toBeNull();
    expect(readSessionGraph).toHaveBeenCalledTimes(1);
  });
});

describe("refresh", () => {
  it("coalesces a burst of changes into one read", async () => {
    vi.useFakeTimers();
    readSessionGraph.mockResolvedValue(snapshot());

    const { refresh } = useGraphStore.getState();
    refresh("s1", true);
    refresh("s1", true);
    refresh("s1", true);

    expect(readSessionGraph).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(readSessionGraph).toHaveBeenCalledTimes(1);
  });

  it("reads an open session it has never seen before", async () => {
    vi.useFakeTimers();
    readSessionGraph.mockResolvedValue(snapshot());

    // The first graph of a run arrives as a change event, not as a load.
    useGraphStore.getState().refresh("s1", true);
    await vi.advanceTimersByTimeAsync(200);

    expect(entry("s1").graph?.name).toBe("Idea Generation");
  });

  it("ignores a file left behind by a session that is no longer open", async () => {
    vi.useFakeTimers();
    readSessionGraph.mockResolvedValue(snapshot());

    // Closing a session leaves its file and its project's watcher in place, so a
    // late write names a session no pane is showing.
    useGraphStore.getState().refresh("closed", false);
    await vi.advanceTimersByTimeAsync(200);

    expect(readSessionGraph).not.toHaveBeenCalled();
    expect(useGraphStore.getState().bySession).toEqual({});
  });

  it("still re-reads a graph it is holding for a session the caller cannot place", async () => {
    readSessionGraph.mockResolvedValue(snapshot());
    await useGraphStore.getState().load("s1");
    vi.useFakeTimers();

    useGraphStore.getState().refresh("s1", false);
    await vi.advanceTimersByTimeAsync(200);

    expect(readSessionGraph).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a session that was closed while the read was queued", async () => {
    vi.useFakeTimers();
    readSessionGraph.mockResolvedValue(snapshot());

    const graphs = useGraphStore.getState();
    graphs.refresh("s1", true);
    graphs.forget("s1");
    await vi.advanceTimersByTimeAsync(200);

    expect(readSessionGraph).not.toHaveBeenCalled();
    expect(useGraphStore.getState().bySession).toEqual({});
  });
});

describe("forget", () => {
  it("drops the graph of a closed session and leaves the others alone", async () => {
    readSessionGraph.mockResolvedValue(snapshot());
    await useGraphStore.getState().load("s1");
    await useGraphStore.getState().load("s2");

    useGraphStore.getState().forget("s1");

    expect(Object.keys(useGraphStore.getState().bySession)).toEqual(["s2"]);
    // A forgotten session reads as one that has nothing yet, not as an error.
    expect(entry("s1").graph).toBeNull();
    expect(entry("s1").error).toBeNull();
  });

  it("ignores a late read that finishes after the session is gone", async () => {
    let release: (value: GraphSnapshot) => void = () => {};
    readSessionGraph.mockReturnValue(
      new Promise<GraphSnapshot>((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = useGraphStore.getState().load("s1");
    useGraphStore.getState().forget("s1");
    release(snapshot());
    await inFlight;

    expect(useGraphStore.getState().bySession).toEqual({});
  });
});

describe("watch", () => {
  it("records a failure on the store instead of throwing past the shell", async () => {
    watchProjectGraphs.mockRejectedValue("could not watch");

    await useGraphStore.getState().watch("p1");

    expect(watchProjectGraphs).toHaveBeenCalledWith("p1");
    expect(useGraphStore.getState().error).toBe("could not watch");
  });
});

describe("syncSessions", () => {
  it("loads every session from one project listing", async () => {
    listSessionGraphs.mockResolvedValue([
      snapshot(),
      snapshot({
        sessionId: "s2",
        path: "/p/.grokspace/graphs/s2.json",
        json: JSON.stringify({ name: "Other run", nodes: [{ id: "a" }] }),
      }),
    ]);

    await useGraphStore.getState().syncSessions("p1");

    expect(listSessionGraphs).toHaveBeenCalledWith("p1");
    expect(readSessionGraph).not.toHaveBeenCalled();
    expect(entry("s1").graph?.name).toBe("Idea Generation");
    expect(entry("s2").graph?.name).toBe("Other run");
  });

  it("drops graphs that are not in the listing", async () => {
    useGraphStore.setState({
      bySession: {
        gone: {
          path: "/p/.grokspace/graphs/gone.json",
          graph: null,
          warnings: [],
          error: null,
          updatedAt: null,
          bytes: 0,
          isLoading: false,
        },
      },
    });
    listSessionGraphs.mockResolvedValue([snapshot()]);

    await useGraphStore.getState().syncSessions("p1");

    expect(Object.keys(useGraphStore.getState().bySession)).toEqual(["s1"]);
  });

  it("lets the later listing win when two complete out of order", async () => {
    let resolveFirst: (value: GraphSnapshot[]) => void = () => {};
    listSessionGraphs.mockImplementationOnce(
      () =>
        new Promise<GraphSnapshot[]>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    listSessionGraphs.mockResolvedValueOnce([
      snapshot({
        sessionId: "s2",
        path: "/p/.grokspace/graphs/s2.json",
        json: null,
        exists: false,
      }),
    ]);

    const first = useGraphStore.getState().syncSessions("p1");
    const second = useGraphStore.getState().syncSessions("p2");
    await second;
    resolveFirst([snapshot()]);
    await first;

    expect(Object.keys(useGraphStore.getState().bySession)).toEqual(["s2"]);
  });

  it("surfaces a failed listing on the store rather than throwing", async () => {
    listSessionGraphs.mockRejectedValue("database is locked");

    await useGraphStore.getState().syncSessions("p1");

    expect(useGraphStore.getState().error).toBe("database is locked");
  });
});
