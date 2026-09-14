import { describe, expect, it } from "vitest";

import type { McpServerInfo } from "../types";
import { MCP_LOADED_BY_GROK, mcpServerNote } from "./mcpVisibility";

const server = (overrides: Partial<McpServerInfo> = {}): McpServerInfo => ({
  name: "filesystem",
  origin: "~/.grok/config.toml",
  scope: "user",
  transport: "stdio",
  detail: "npx",
  heldOff: false,
  ...overrides,
});

describe("mcpServerNote", () => {
  it("marks project rows held off and keeps the grok-not-host copy", () => {
    expect(mcpServerNote(server())).toBe("Loaded by grok");
    expect(mcpServerNote(server({ scope: "project", heldOff: true, name: "evil" }))).toBe(
      "Held off — untrusted folder keeps project MCP off",
    );
    expect(MCP_LOADED_BY_GROK).toBe("MCP is loaded by grok, not GrokSpace.");
  });
});
