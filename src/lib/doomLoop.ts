/**
 * Host-side guard against an agent repeating the same ACP tool.
 *
 * The identity is the tool update text (title plus args). Different args are
 * different tools. `tool_call_update` never reaches here — protocol drops it
 * so one long call cannot look like a loop.
 *
 * The default is 5. Pass a smaller N in tests (OpenCode trips at 3). A later
 * Settings control can feed the same argument; retryable tests false-positive
 * if this is too low.
 */

/** Matches `acp/protocol.rs`. */
export const DEFAULT_DOOM_LOOP_THRESHOLD = 5;

export interface ToolRepeat {
  text: string;
  count: number;
}

export function noteToolRepeat(
  previous: ToolRepeat | undefined,
  text: string,
): ToolRepeat {
  if (previous !== undefined && previous.text === text) {
    return { text, count: previous.count + 1 };
  }
  return { text, count: 1 };
}

export function doomLoopTripped(
  repeat: ToolRepeat | undefined,
  threshold: number = DEFAULT_DOOM_LOOP_THRESHOLD,
): boolean {
  return threshold > 0 && (repeat?.count ?? 0) >= threshold;
}

export function doomLoopNotice(title: string, repeat: ToolRepeat): string {
  const who = title.trim() || "Agent";
  return `${who} · same tool ${repeat.count} times: ${repeat.text}`;
}
