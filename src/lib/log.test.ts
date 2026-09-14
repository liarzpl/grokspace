import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientErrorMessage,
  isQuietHostError,
  listenLogged,
  logCaught,
  logClientError,
} from "./log";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

afterEach(() => {
  vi.clearAllMocks();
});

describe("clientErrorMessage", () => {
  it("unwraps strings, Errors, and anything else", () => {
    expect(clientErrorMessage("plain")).toBe("plain");
    expect(clientErrorMessage(new Error("boom"))).toBe("boom");
    expect(clientErrorMessage({ reason: "nope" })).toBe("Something went wrong.");
  });
});

describe("isQuietHostError", () => {
  it("treats write-after-exit and a missing pty as expected", () => {
    expect(isQuietHostError("that session is no longer running")).toBe(true);
    expect(isQuietHostError("no session found with id abc")).toBe(true);
    expect(isQuietHostError("could not write to the session: broken pipe")).toBe(false);
  });
});

describe("logClientError", () => {
  it("invokes the host command and swallows a failed write", async () => {
    invokeMock.mockRejectedValueOnce(new Error("offline"));
    logClientError("banner", "load failed");
    expect(invokeMock).toHaveBeenCalledWith("log_client_error", {
      source: "banner",
      message: "load failed",
    });
    await Promise.resolve();
  });
});

describe("logCaught", () => {
  it("logs and returns the display string", () => {
    expect(logCaught("attach", new Error("no session found with id x"))).toBe(
      "no session found with id x",
    );
    expect(invokeMock).toHaveBeenCalledWith("log_client_error", {
      source: "attach",
      message: "no session found with id x",
    });
  });
});

describe("listenLogged", () => {
  it("forwards a successful subscribe", async () => {
    const stop = vi.fn();
    listenMock.mockResolvedValueOnce(stop);
    const handler = vi.fn();
    await expect(listenLogged("session-exited", handler)).resolves.toBe(stop);
    expect(listenMock).toHaveBeenCalledWith("session-exited", handler);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("logs a failed subscribe and returns a no-op unlisten", async () => {
    listenMock.mockRejectedValueOnce(new Error("no webview"));
    const stop = await listenLogged("graph-changed", vi.fn());
    expect(invokeMock).toHaveBeenCalledWith("log_client_error", {
      source: "listen",
      message: "graph-changed: no webview",
    });
    expect(() => stop()).not.toThrow();
  });
});
