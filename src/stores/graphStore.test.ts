import { beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_GRAPH } from "../lib/graphFixture";
import type { GraphSnapshot } from "../types";

const readSessionGraph = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { errorMessage: actual.errorMessage, api: { readSessionGraph } };
});

const { graphFor, useGraphStore } = await import("./graphStore");

function snapshot(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    sessionId: "s1",
    path: "/p/.grokspace/graphs/s1.json",
    exists: true,
    json: JSON.stringify(SAMPLE_GRAPH),
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

  it("is reported when the document is valid JSON but not a graph", async () => {
    readSessionGraph.mockResolvedValue(snapshot({ json: '{"name": "no nodes here"}' }));

    await useGraphStore.getState().load("s1");

    expect(entry("s1").error).toContain("nodes");
  });
});

describe("refresh", () => {
  it("coalesces a burst of changes into one read", async () => {
    vi.useFakeTimers();
    readSessionGraph.mockResolvedValue(snapshot());

    const { refresh } = useGraphStore.getState();
    refresh("s1");
    refresh("s1");
    refresh("s1");

    expect(readSessionGraph).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(readSessionGraph).toHaveBeenCalledTimes(1);
  });

  it("reads a session it has never seen before", async () => {
    vi.useFakeTimers();
    readSessionGraph.mockResolvedValue(snapshot());

    // The first graph of a run arrives as a change event, not as a load.
    useGraphStore.getState().refresh("s1");
    await vi.advanceTimersByTimeAsync(200);

    expect(entry("s1").graph?.name).toBe("Idea Generation");
  });

  it("does not resurrect a session that was closed while the read was queued", async () => {
    vi.useFakeTimers();
    readSessionGraph.mockResolvedValue(snapshot());

    const graphs = useGraphStore.getState();
    graphs.refresh("s1");
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
