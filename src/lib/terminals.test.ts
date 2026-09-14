import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Terminal / FitAddon / Channel are stubbed: TEST-004 (WP-32) is the Map
 * lifecycle and byte normalisation, not a WebGL or canvas renderer.
 */
const {
  attachSession,
  writeSession,
  FakeElement,
  FakeTerminal,
  FakeFitAddon,
  FakeChannel,
  webgl,
} = vi.hoisted(() => {
  class FakeElement {
    style: { height: string; width: string } = { height: "", width: "" };
    parentElement: FakeElement | null = null;
    children: FakeElement[] = [];

    get childElementCount(): number {
      return this.children.length;
    }

    replaceChildren(...nodes: FakeElement[]): void {
      for (const child of this.children) child.parentElement = null;
      this.children = nodes;
      for (const node of nodes) node.parentElement = this;
    }

    remove(): void {
      const parent = this.parentElement;
      if (!parent) return;
      parent.children = parent.children.filter((child) => child !== this);
      this.parentElement = null;
    }
  }

  class FakeTerminal {
    cols = 80;
    rows = 24;
    readonly handlers: Array<(data: string) => void> = [];
    readonly options: Record<string, unknown>;
    readonly open = vi.fn();
    readonly write = vi.fn();
    readonly writeln = vi.fn();
    readonly refresh = vi.fn();
    readonly clear = vi.fn();
    readonly focus = vi.fn();
    readonly dispose = vi.fn();
    readonly loadAddon = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }

    onData(handler: (data: string) => void): { dispose: () => void } {
      this.handlers.push(handler);
      return { dispose: () => {} };
    }
  }

  class FakeFitAddon {
    readonly proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }));
    readonly fit = vi.fn();
  }

  class FakeChannel {
    onmessage: ((chunk: ArrayBuffer | ArrayBufferView | number[]) => void) | undefined;
  }

  return {
    attachSession: vi.fn(async (_id: string, _channel: FakeChannel) => {}),
    writeSession: vi.fn(async (_id: string, _data: string) => {}),
    FakeElement,
    FakeTerminal,
    FakeFitAddon,
    FakeChannel,
    webgl: { throwOnConstruct: false, constructed: 0 },
  };
});

vi.stubGlobal("document", {
  createElement: () => new FakeElement(),
  documentElement: {},
});
vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: FakeFitAddon }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      webgl.constructed += 1;
      if (webgl.throwOnConstruct) throw new Error("no gpu");
    }
    onContextLoss = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: FakeChannel,
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("./api", () => ({ api: { attachSession, writeSession } }));

import {
  acquireTerminal,
  attachTerminal,
  clearTerminal,
  detachTerminal,
  disposeTerminal,
  fitTerminal,
  focusTerminal,
  mountTerminal,
  writeNotice,
} from "./terminals";

function host(): HTMLElement {
  return new FakeElement() as unknown as HTMLElement;
}

function termOf(sessionId: string): InstanceType<typeof FakeTerminal> {
  return acquireTerminal(sessionId).term as unknown as InstanceType<typeof FakeTerminal>;
}

function fitOf(sessionId: string): InstanceType<typeof FakeFitAddon> {
  return acquireTerminal(sessionId).fit as unknown as InstanceType<typeof FakeFitAddon>;
}

function lastChannel(): InstanceType<typeof FakeChannel> {
  const channel = attachSession.mock.calls.at(-1)?.[1] as InstanceType<typeof FakeChannel> | undefined;
  if (!channel) throw new Error("attachSession was not given a channel");
  return channel;
}

/** Lets a mount's fire-and-forget `enableWebgl()` finish before the next test. */
async function settleBackground(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(async () => {
  await settleBackground();
  disposeTerminal("s1");
  disposeTerminal("s2");
  webgl.throwOnConstruct = false;
  webgl.constructed = 0;
  vi.clearAllMocks();
});

beforeEach(() => {
  attachSession.mockResolvedValue(undefined);
  writeSession.mockResolvedValue(undefined);
});

describe("acquireTerminal / mountTerminal", () => {
  it("reuses one Terminal and one onData handler across remounts", () => {
    const first = host();
    const a = mountTerminal("s1", first);
    const b = mountTerminal("s1", first);

    expect(b).toBe(a);
    expect(termOf("s1").handlers).toHaveLength(1);
    expect(termOf("s1").open).toHaveBeenCalledOnce();
  });

  it("does not register a second onData after a StrictMode detach + remount", () => {
    const first = host();
    const second = host();
    mountTerminal("s1", first);
    detachTerminal("s1");
    mountTerminal("s1", second);

    expect(termOf("s1").handlers).toHaveLength(1);
    expect(termOf("s1").open).toHaveBeenCalledOnce();
  });

  it("opens the terminal only the first time, then refreshes after a host move", () => {
    const first = host();
    const second = host();
    mountTerminal("s1", first);
    const term = termOf("s1");
    expect(term.refresh).not.toHaveBeenCalled();

    mountTerminal("s1", second);
    expect(term.open).toHaveBeenCalledOnce();
    expect(term.refresh).toHaveBeenCalledWith(0, term.rows - 1);
    expect((second as unknown as InstanceType<typeof FakeElement>).children).toHaveLength(1);
  });

  it("replaces leftover host children even when this container did not move", () => {
    const pane = host();
    mountTerminal("s1", pane);
    const leftover = new FakeElement();
    (pane as unknown as InstanceType<typeof FakeElement>).children.push(leftover);
    leftover.parentElement = pane as unknown as InstanceType<typeof FakeElement>;

    mountTerminal("s1", pane);
    const el = pane as unknown as InstanceType<typeof FakeElement>;
    expect(el.childElementCount).toBe(1);
    expect(el.children[0]).toBe(acquireTerminal("s1").container);
    expect(leftover.parentElement).toBeNull();
  });

  it("sends keystrokes once through writeSession and swallows a dead session", async () => {
    mountTerminal("s1", host());
    const [onData] = termOf("s1").handlers;
    onData?.("ls\r");
    expect(writeSession).toHaveBeenCalledExactlyOnceWith("s1", "ls\r");

    writeSession.mockRejectedValueOnce(new Error("exited"));
    onData?.("x");
    await settleBackground();
    expect(writeSession).toHaveBeenCalledTimes(2);
  });
});

describe("attachTerminal", () => {
  it("writes ArrayBuffer, view, and number[] payloads as Uint8Array", async () => {
    await attachTerminal("s1");
    const term = termOf("s1");
    const channel = lastChannel();
    if (!channel.onmessage) throw new Error("channel onmessage unset");

    const raw = new Uint8Array([0, 10, 20, 30, 40]);
    channel.onmessage(raw.buffer.slice(1, 4));
    channel.onmessage(raw.subarray(1, 4));
    channel.onmessage([65, 66]);

    const written = term.write.mock.calls.map(([chunk]) => [...(chunk as Uint8Array)]);
    expect(written).toEqual([
      [10, 20, 30],
      [10, 20, 30],
      [65, 66],
    ]);
    for (const [chunk] of term.write.mock.calls) {
      expect(chunk).toBeInstanceOf(Uint8Array);
    }
  });

  it("is a no-op while attached, and retries after attachSession fails", async () => {
    attachSession.mockRejectedValueOnce(new Error("pty gone"));
    await expect(attachTerminal("s1")).rejects.toThrow("pty gone");
    expect(acquireTerminal("s1").attached).toBe(false);

    attachSession.mockResolvedValueOnce(undefined);
    await attachTerminal("s1");
    await attachTerminal("s1");
    expect(attachSession).toHaveBeenCalledTimes(2);
    expect(acquireTerminal("s1").attached).toBe(true);
  });
});

describe("fitTerminal", () => {
  it("returns null when the session is missing or not yet open", () => {
    expect(fitTerminal("missing")).toBeNull();
    acquireTerminal("s1");
    expect(fitTerminal("s1")).toBeNull();
    expect(fitOf("s1").fit).not.toHaveBeenCalled();
  });

  it("returns null when the host is not measurable yet", () => {
    mountTerminal("s1", host());
    const fit = fitOf("s1");
    fit.proposeDimensions.mockReturnValueOnce(undefined as unknown as { cols: number; rows: number });
    expect(fitTerminal("s1")).toBeNull();
    fit.proposeDimensions.mockReturnValueOnce({ cols: 0, rows: 24 });
    expect(fitTerminal("s1")).toBeNull();
    expect(fit.fit).not.toHaveBeenCalled();
  });

  it("fits an opened pane and returns the terminal grid", () => {
    mountTerminal("s1", host());
    const term = termOf("s1");
    term.cols = 100;
    term.rows = 30;
    expect(fitTerminal("s1")).toEqual({ cols: 100, rows: 30 });
    expect(fitOf("s1").fit).toHaveBeenCalledOnce();
  });
});

describe("pane helpers", () => {
  it("no-ops clear, focus, notice, and detach when the session is unknown", () => {
    expect(() => {
      clearTerminal("missing");
      focusTerminal("missing");
      writeNotice("missing", "gone");
      detachTerminal("missing");
      disposeTerminal("missing");
    }).not.toThrow();
  });

  it("forwards clear, focus, and a dimmed notice to the live terminal", () => {
    mountTerminal("s1", host());
    const term = termOf("s1");
    clearTerminal("s1");
    focusTerminal("s1");
    writeNotice("s1", "session exited");
    expect(term.clear).toHaveBeenCalledOnce();
    expect(term.focus).toHaveBeenCalledOnce();
    expect(term.writeln).toHaveBeenCalledExactlyOnceWith("\r\n\x1b[2msession exited\x1b[0m");
  });

  it("detaches the container without disposing, then dispose drops the Map entry", () => {
    const pane = host();
    mountTerminal("s1", pane);
    const term = termOf("s1");
    const container = acquireTerminal("s1").container;

    detachTerminal("s1");
    expect(term.dispose).not.toHaveBeenCalled();
    expect(container.parentElement).toBeNull();
    expect(acquireTerminal("s1").term).toBe(term);

    disposeTerminal("s1");
    expect(term.dispose).toHaveBeenCalledOnce();
    const next = acquireTerminal("s1");
    expect(next.term).not.toBe(term);
    expect(termOf("s1").handlers).toHaveLength(1);
  });
});

describe("enableWebgl", () => {
  it("loads WebGL after open", async () => {
    mountTerminal("s1", host());
    await vi.waitFor(() => {
      expect(termOf("s1").loadAddon).toHaveBeenCalledTimes(2);
    });
    expect(webgl.constructed).toBe(1);
  });

  it("keeps the opened pane when WebGL construction throws", async () => {
    webgl.throwOnConstruct = true;
    const entry = mountTerminal("s2", host());
    await vi.waitFor(() => {
      expect(webgl.constructed).toBe(1);
    });
    expect(entry.opened).toBe(true);
    expect(termOf("s2").loadAddon).toHaveBeenCalledOnce();
  });
});
