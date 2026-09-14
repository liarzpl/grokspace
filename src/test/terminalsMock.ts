import { vi } from "vitest";

/**
 * The real module pulls in xterm and its stylesheet. Component tests that
 * reach a store only need the registry's function names.
 */
export const acquireTerminal = vi.fn();
export const mountTerminal = vi.fn();
export const attachTerminal = vi.fn().mockResolvedValue(undefined);
export const fitTerminal = vi.fn().mockReturnValue(null);
export const clearTerminal = vi.fn();
export const focusTerminal = vi.fn();
export const writeNotice = vi.fn();
export const detachTerminal = vi.fn();
export const disposeTerminal = vi.fn();
