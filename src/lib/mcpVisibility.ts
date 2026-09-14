import type { McpServerInfo } from "../types";

/** Copy on every Settings MCP row. Host does not start these processes. */
export const MCP_LOADED_BY_GROK = "MCP is loaded by grok, not GrokSpace.";

export function mcpServerNote(server: McpServerInfo): string {
  if (server.heldOff) {
    return "Held off — untrusted folder keeps project MCP off";
  }
  return "Loaded by grok";
}
