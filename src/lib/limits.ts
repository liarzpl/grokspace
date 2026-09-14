/**
 * Caps and classic PTY size, in one place.
 *
 * Memory and step lists are enforced in Rust; these copies are for UI warnings
 * and spawn size. A `limits` command would keep them honest automatically —
 * until then they are named here so a drift is a one-file edit.
 */

export const FALLBACK_PTY_SIZE = { cols: 80, rows: 24 } as const;

/** Matches `memory.rs`. Counted in Unicode scalar values. */
export const MAX_MEMORY_CHARS = 32 * 1024;

/** Matches `steps.rs`. How many titles a session's list will hold. */
export const MAX_STEPS = 20;
